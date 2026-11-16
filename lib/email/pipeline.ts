import { createHash } from "crypto";
import type { Sql } from "@/lib/db";
import { getDefaultAccountId } from "@/lib/accounts";
import { resolveAccount } from "@/lib/email/accountResolution";
import { applyPlan, finishEvent } from "@/lib/email/apply";
import { loadAlertAccounts, loadCandidates, loadMerchantByKey, loadScopeTimezone } from "@/lib/email/context";
import { decide, type Plan } from "@/lib/email/decide";
import { checkDkim } from "@/lib/email/dkim";
import { matchIgnoreList } from "@/lib/email/ignoreList";
import { displayNameFromRaw, merchantKey } from "@/lib/email/merchantKey";
import { normalizeEmail } from "@/lib/email/normalize";
import { resolveAlertOccurredAt } from "@/lib/email/occurredAt";
import { parserForSender } from "@/lib/email/registry";
import { getEmailSyncSettings, normalizeCounterparty } from "@/lib/email/settings";
import type { EmailPayload, ParsedAlert, ParseResult } from "@/lib/email/types";
import { isParsedAlert } from "@/lib/email/types";
import { notifyNeedsReview } from "@/lib/push";

/**
 * Steps 3–10 of the ingest pipeline (plan §3) for ONE stored event.
 *
 * Shared by the ingest route, the Re-read button and the unknown-account
 * "assign and re-process" flow, so all three behave identically.
 *
 * Failure semantics (plan §5.2):
 *   - A parser bug never escapes: a throw becomes `unparsed` with `error` set.
 *   - Only infrastructure errors (the database) propagate, leaving the event
 *     in `received` so the poller's retry re-processes it (C14).
 *   - A push failure is logged and never fails the request.
 *
 * NEVER log request bodies or email text here: it would put bank email into
 * the Vercel logs.
 */

export type ProcessResult = {
  status: string;
  reason: string | null;
  transactionId: string | null;
};

type EventRow = {
  id: string;
  gmail_message_id: string;
  from_address: string;
  to_address: string | null;
  forwarded_for: string | null;
  subject: string | null;
  received_at: string | Date;
  auth_results: string | null;
  arc_auth_results: string | null;
  raw_text: string | null;
  raw_html: string | null;
  body_sha256: string;
  truncated: boolean;
  mode_at_receipt: string;
};

export function bodySha256(plainBody: string, htmlBody: string): string {
  return createHash("sha256").update(plainBody).update("\u0000").update(htmlBody).digest("hex");
}

/** Validate what a parser returned before anything trusts it. */
function sanitizeAlert(result: ParsedAlert): ParsedAlert | null {
  if (!Number.isSafeInteger(result.amountCents) || result.amountCents <= 0) return null;
  if (typeof result.merchantRaw !== "string" || !result.merchantRaw.trim()) return null;
  const last4 = result.accountHint?.last4;
  if (last4 !== undefined && !/^\d{4}$/.test(last4)) return null;
  return { ...result, merchantRaw: result.merchantRaw.trim(), accountHint: result.accountHint ?? {} };
}

function toIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export async function loadEventEmail(sql: Sql, userId: string, eventId: string) {
  const rows = (await sql`
    SELECT id, gmail_message_id, from_address, to_address, forwarded_for, subject, received_at,
           auth_results, arc_auth_results, raw_text, raw_html, body_sha256, truncated, mode_at_receipt
      FROM email_events
     WHERE user_id = ${userId} AND id = ${eventId}::uuid
  `) as EventRow[];
  const ev = rows[0];
  if (!ev) return null;
  const payload: EmailPayload = {
    gmailMessageId: ev.gmail_message_id,
    rfc822MessageId: null,
    from: ev.from_address,
    to: ev.to_address,
    subject: ev.subject ?? "",
    date: toIso(ev.received_at),
    plainBody: ev.raw_text ?? "",
    htmlBody: ev.raw_html ?? "",
    truncated: ev.truncated,
    headers: {
      deliveredTo: null,
      xForwardedFor: ev.forwarded_for,
      xForwardedTo: null,
      authenticationResults: ev.auth_results,
      arcAuthenticationResults: ev.arc_auth_results,
    },
    pollerVersion: null,
  };
  return { ev, email: normalizeEmail(payload) };
}

export async function processEvent(sql: Sql, userId: string, eventId: string): Promise<ProcessResult> {
  const loaded = await loadEventEmail(sql, userId, eventId);
  if (!loaded) return { status: "missing", reason: "event_not_found", transactionId: null };
  const { ev, email } = loaded;

  const finish = async (
    status: string,
    reason: string | null,
    extra: Parameters<typeof finishEvent>[3] = { status },
  ): Promise<ProcessResult> => {
    await finishEvent(sql, userId, eventId, { ...extra, status, reason });
    return { status, reason, transactionId: null };
  };

  // 3a. Expected non-transaction mail (Gmail forwarding confirmations, Apps
  //     Script failure notices, Google account notices).
  const ignored = matchIgnoreList(email);
  if (ignored) {
    if (ignored.raisesWarning) {
      await sql`
        INSERT INTO email_sync_settings (user_id, last_poller_failure_at)
        VALUES (${userId}::uuid, now())
        ON CONFLICT (user_id) DO UPDATE SET last_poller_failure_at = now(), updated_at = now()
      `;
    }
    return finish("ignored", ignored.reason);
  }

  // 3b. Route to a parser.
  const parser = parserForSender(email);
  if (!parser) return finish("unparsed", "no_parser");

  // 4. Authenticate before reading a single field from the body.
  if (parser.requireDkim !== false) {
    const verdict = checkDkim(email.authResults, email.arcAuthResults, parser.dkimDomains);
    if (!verdict.pass) {
      return finish("unauthenticated", verdict.reason, {
        status: "unauthenticated",
        parserId: parser.id,
        parserVersion: parser.version,
      });
    }
  }

  // 5. Parse. A throw is a parser bug: record it, never 5xx (a 5xx would make
  //    the poller retry a deterministic failure every minute for a week).
  let result: ParseResult;
  try {
    result = parser.parse(email);
  } catch (err) {
    return finish("unparsed", "parser_threw", {
      status: "unparsed",
      parserId: parser.id,
      parserVersion: parser.version,
      error: err instanceof Error ? err.message.slice(0, 500) : "parser threw",
    });
  }
  const parserMeta = { parserId: parser.id, parserVersion: parser.version };
  if ("unparsed" in result) {
    return finish("unparsed", result.unparsed, { status: "unparsed", ...parserMeta });
  }
  if ("ignore" in result) {
    return finish("ignored", result.ignore, {
      status: "ignored",
      ...parserMeta,
      parsed: result.kind ? { kind: result.kind } : undefined,
    });
  }
  const alert = isParsedAlert(result) ? sanitizeAlert(result) : null;
  if (!alert) return finish("unparsed", "invalid_parse", { status: "unparsed", ...parserMeta, parsed: result });

  // 6. Account.
  const accounts = await loadAlertAccounts(sql, userId);
  const resolved = resolveAccount(parser, alert, email, accounts);
  if (!resolved.account) {
    return finish("unknown_account", resolved.reason, {
      status: "unknown_account",
      ...parserMeta,
      parsed: alert,
      decision: { accountKey: resolved.key, parserId: parser.id },
    });
  }

  // 7. Context.
  const [settings, timeZone, defaultAccountId] = await Promise.all([
    getEmailSyncSettings(sql, userId),
    loadScopeTimezone(sql, userId),
    getDefaultAccountId(sql, userId),
  ]);
  const occurredAt = resolveAlertOccurredAt({
    occurredAt: alert.occurredAt,
    occurredDate: alert.occurredDate,
    emailReceivedAt: email.receivedAt,
    timeZone,
  });
  const key = merchantKey(alert.merchantRaw);
  const [merchant, candidates] = await Promise.all([
    loadMerchantByKey(sql, userId, key),
    loadCandidates(sql, userId, occurredAt),
  ]);

  // Shadow if the scope is in shadow NOW, or was when this email arrived —
  // switching to live never backfills mail that arrived during shadow.
  const mode = settings.mode === "live" && ev.mode_at_receipt === "live" ? "live" : "shadow";

  // 8. Decide (pure).
  const plan: Plan = decide({
    mode,
    timeZone,
    internalCounterparties: settings.internalCounterparties.map(normalizeCounterparty),
    parser: { id: parser.id, accountKey: parser.accountKey },
    event: {
      id: ev.id,
      gmailMessageId: ev.gmail_message_id,
      bodySha256: ev.body_sha256,
      forwardedFor: email.forwardedFor,
      receivedAt: email.receivedAt,
    },
    alert,
    occurredAt,
    merchantKey: key,
    merchant,
    account: resolved.account,
    accounts,
    defaultAccountId,
    candidates,
  });

  const summary = {
    accountId: resolved.account.id,
    accountName: resolved.account.name,
    occurredAt,
    merchantKey: key,
    merchantName: merchant?.displayName ?? displayNameFromRaw(alert.merchantRaw),
    amountCents: alert.amountCents,
    alertKind: alert.kind,
    mode,
  };

  // 9. Apply — or, in shadow, store what WOULD have happened and nothing else.
  if (mode === "shadow") {
    await finishEvent(sql, userId, eventId, {
      status: "shadow",
      reason: plan.reason,
      ...parserMeta,
      parsed: alert,
      decision: { ...plan, wouldBe: plan.status, summary },
    });
    return { status: "shadow", reason: plan.reason, transactionId: null };
  }

  const { transactionId } = await applyPlan(sql, {
    userId,
    eventId,
    occurredAt,
    merchantKey: key,
    merchantRaw: alert.merchantRaw,
    merchant,
    plan,
    ...parserMeta,
    parsed: alert,
    decisionExtra: { summary },
  });

  // 10. Notify (Phase 5). Never fails the request.
  if (plan.action === "create" && plan.notify && transactionId) {
    try {
      await notifyNeedsReview(sql, userId, {
        transactionId,
        accountId: resolved.account.id,
        accountName: resolved.account.name,
        merchantName: summary.merchantName,
        amountCents: alert.amountCents,
        choices: plan.choices,
        description: plan.transactions.find((t) => t.ref === "primary")?.description ?? null,
        toPerson: parser.id === "venmo",
      });
    } catch (err) {
      console.error("email-sync: push fan-out failed", err instanceof Error ? err.message : err);
    }
  }

  return { status: plan.status, reason: plan.reason, transactionId };
}
