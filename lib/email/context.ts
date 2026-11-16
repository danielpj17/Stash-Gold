import type { Sql } from "@/lib/db";
import type { AccountRef, CandidateRow } from "@/lib/email/decide";
import { EMAIL_SYNC_CONFIG } from "@/lib/email/config";
import { merchantKey } from "@/lib/email/merchantKey";
import type { MerchantRule, MerchantMode } from "@/lib/email/rules";
import type { ParsedAlertKind } from "@/lib/email/types";

/**
 * Loads what decide() needs. Every query filters on the SCOPE (`userId`),
 * including the EXISTS subqueries (invariant 1).
 */

type AccountRow = {
  id: string;
  name: string;
  kind: string;
  is_default: boolean;
  alert_source: string | null;
  alert_last4: string | null;
  alert_forwarded_from: string | null;
  unattended_action: string | null;
};

/**
 * Live accounts, archived ones included: an archived card can still send an
 * alert, and silently dropping it would be worse than recording it.
 */
export async function loadAlertAccounts(sql: Sql, userId: string): Promise<AccountRef[]> {
  const rows = (await sql`
    SELECT id, name, kind, is_default, alert_source, alert_last4, alert_forwarded_from,
           unattended_action
      FROM financial_accounts
     WHERE user_id = ${userId} AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC
  `) as AccountRow[];
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    kind: String(r.kind),
    isDefault: r.is_default === true,
    alertSource: r.alert_source,
    alertLast4: r.alert_last4,
    alertForwardedFrom: r.alert_forwarded_from,
    unattendedAction: r.unattended_action === "auto_guess" ? "auto_guess" : "keep_in_review",
  }));
}

type MerchantRow = {
  id: string;
  display_name: string;
  mode: string;
  category: string | null;
  shortlist: string[] | null;
  default_category: string | null;
};

export function mapMerchant(row: MerchantRow): MerchantRule {
  const mode: MerchantMode =
    row.mode === "auto" || row.mode === "ask_shortlist" ? row.mode : "ask_all";
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    mode,
    category: row.category,
    shortlist: Array.isArray(row.shortlist) ? row.shortlist : [],
    defaultCategory: row.default_category,
  };
}

export async function loadMerchantByKey(
  sql: Sql,
  userId: string,
  key: string,
): Promise<MerchantRule | null> {
  if (!key) return null;
  const rows = (await sql`
    SELECT m.id, m.display_name, m.mode, m.category, m.shortlist, m.default_category
      FROM merchant_aliases a
      JOIN merchants m ON m.user_id = a.user_id AND m.id = a.merchant_id
     WHERE a.user_id = ${userId} AND a.normalized_key = ${key}
  `) as MerchantRow[];
  return rows[0] ? mapMerchant(rows[0]) : null;
}

type CandidateDbRow = {
  id: string;
  kind: string;
  occurred_at: string | Date;
  created_at: string | Date;
  amount: string | number;
  original_amount: string | number | null;
  category: string | null;
  review_status: string;
  source: string;
  account: string | null;
  transfer_from: string | null;
  transfer_to: string | null;
  is_pending: boolean;
  merchant_id: string | null;
  email_event_id: string | null;
  auto_merged: boolean;
  claimed: boolean;
  gmail_message_id: string | null;
  body_sha256: string | null;
  forwarded_for: string | null;
  event_kind: string | null;
  merchant_raw: string | null;
};

function toIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function toCents(value: string | number | null | undefined): number {
  return Math.round(Number(value ?? 0) * 100);
}

/** Rows near `occurredAt` that any dedupe / follow-up rule might pair with. */
export async function loadCandidates(
  sql: Sql,
  userId: string,
  occurredAt: string,
): Promise<CandidateRow[]> {
  const before = EMAIL_SYNC_CONFIG.followupWindowDays + 1;
  const after = Math.max(EMAIL_SYNC_CONFIG.followupWindowDays, EMAIL_SYNC_CONFIG.manualMatchWindowDays) + 1;
  const rows = (await sql`
    SELECT t.id, t.kind, t.occurred_at, t.created_at, t.amount, t.original_amount,
           t.category, t.review_status, t.source, t.account, t.transfer_from, t.transfer_to,
           t.is_pending, t.merchant_id, t.email_event_id, t.auto_merged,
           (
             EXISTS (
               SELECT 1 FROM reconciliation_claim_links c
                WHERE c.user_id = t.user_id AND c.sheet_name = 'Expenses' AND c.sheet_row_id = t.id
             )
             OR EXISTS (
               SELECT 1 FROM reconciliation_transfer_claim_links tc
                WHERE tc.user_id = t.user_id AND tc.transfer_sheet_row_id = t.id
             )
           ) AS claimed,
           e.gmail_message_id, e.body_sha256, e.forwarded_for,
           e.parsed->>'kind' AS event_kind,
           e.parsed->>'merchantRaw' AS merchant_raw
      FROM transactions t
      LEFT JOIN email_events e ON e.user_id = t.user_id AND e.id = t.email_event_id
     WHERE t.user_id = ${userId}
       AND t.occurred_at >= ${occurredAt}::timestamptz - make_interval(days => ${before})
       AND t.occurred_at <= ${occurredAt}::timestamptz + make_interval(days => ${after})
     ORDER BY t.occurred_at ASC
     LIMIT 2000
  `) as CandidateDbRow[];

  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind === "income" || r.kind === "transfer" ? r.kind : "expense",
    occurredAt: toIso(r.occurred_at),
    createdAt: toIso(r.created_at),
    amountCents: toCents(r.amount),
    originalAmountCents: r.original_amount === null ? null : toCents(r.original_amount),
    category: r.category,
    reviewStatus: r.review_status === "needs_review" ? "needs_review" : "confirmed",
    source:
      r.source === "shortcut" || r.source === "email" || r.source === "csv" ? r.source : "manual",
    account: r.account,
    transferFrom: r.transfer_from,
    transferTo: r.transfer_to,
    isPending: r.is_pending === true,
    merchantId: r.merchant_id,
    emailEventId: r.email_event_id,
    autoMerged: r.auto_merged === true,
    claimed: r.claimed === true,
    eventGmailMessageId: r.gmail_message_id,
    eventBodySha256: r.body_sha256,
    eventForwardedFor: r.forwarded_for,
    eventKind: (r.event_kind as ParsedAlertKind | null) ?? null,
    eventMerchantKey: r.merchant_raw ? merchantKey(r.merchant_raw) : null,
  }));
}

export async function loadScopeTimezone(sql: Sql, userId: string): Promise<string> {
  const rows = (await sql`SELECT timezone FROM users WHERE id = ${userId}`) as Array<{ timezone: string }>;
  return rows[0]?.timezone || "America/Denver";
}
