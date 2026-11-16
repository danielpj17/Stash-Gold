/**
 * Dry-run the CURRENT parsers over stored email events and print what would
 * change (plan §5.8). A script, not a button, because --apply rewrites history.
 *
 *   npm run email:reparse -- --parser venmo            # dry run
 *   npm run email:reparse -- --parser venmo --apply    # update eligible rows
 *
 * --apply updates only transactions that are (a) unclaimed in reconciliation
 * and (b) have no manual or CSV amount change in their history, and only their
 * amount / date. It never creates or deletes rows. For events that were
 * unparsed before, use Settings → Email sync → Re-read instead, which runs the
 * full pipeline.
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { normalizeEmail } from "@/lib/email/normalize";
import { resolveAlertOccurredAt } from "@/lib/email/occurredAt";
import { validateEmailPayload } from "@/lib/email/payload";
import { parserById } from "@/lib/email/registry";
import { isParsedAlert } from "@/lib/email/types";

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env.local", ".env"]) {
    try {
      const m = readFileSync(file, "utf8").match(/^DATABASE_URL[ \t]*=[ \t]*(.*)$/m);
      if (m?.[1].trim()) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      /* next */
    }
  }
  throw new Error("DATABASE_URL is not set");
}

const args = process.argv.slice(2);
const parserId = args[args.indexOf("--parser") + 1];
const apply = args.includes("--apply");
const parser = parserById(args.includes("--parser") ? parserId : null);
if (!parser) {
  console.error("Usage: npm run email:reparse -- --parser <id> [--apply]");
  process.exit(1);
}

const sql = neon(databaseUrl());
const events = (await sql`
  SELECT e.user_id, e.id, e.gmail_message_id, e.from_address, e.to_address, e.forwarded_for, e.subject,
         e.received_at, e.auth_results, e.arc_auth_results, e.raw_text, e.raw_html, e.status,
         e.parsed, e.transaction_id, u.timezone,
         t.amount, t.occurred_at,
         EXISTS (SELECT 1 FROM reconciliation_claim_links c
                  WHERE c.user_id = e.user_id AND c.sheet_name = 'Expenses' AND c.sheet_row_id = t.id) AS claimed,
         EXISTS (SELECT 1 FROM transaction_amount_changes ac
                  WHERE ac.user_id = e.user_id AND ac.transaction_id = t.id AND ac.reason IN ('manual', 'csv')) AS hand_edited
    FROM email_events e
    JOIN users u ON u.id = e.user_id
    LEFT JOIN transactions t ON t.user_id = e.user_id AND t.id = e.transaction_id AND t.email_event_id = e.id
   WHERE e.parser_id = ${parser.id}
   ORDER BY e.received_at ASC
`) as Array<Record<string, unknown>>;

let changed = 0;
let applied = 0;
for (const ev of events) {
  const payload = validateEmailPayload({
    gmailMessageId: ev.gmail_message_id,
    from: ev.from_address,
    to: ev.to_address,
    subject: ev.subject ?? "",
    date: new Date(String(ev.received_at)).toISOString(),
    plainBody: ev.raw_text ?? "",
    htmlBody: ev.raw_html ?? "",
    headers: {
      "X-Forwarded-For": ev.forwarded_for,
      "Authentication-Results": ev.auth_results,
      "ARC-Authentication-Results": ev.arc_auth_results,
    },
  });
  if ("error" in payload) continue;
  let result;
  try {
    result = parser.parse(normalizeEmail(payload));
  } catch (err) {
    console.log(`${ev.gmail_message_id}: parser threw — ${err instanceof Error ? err.message : err}`);
    continue;
  }
  const before = (ev.parsed ?? null) as Record<string, unknown> | null;
  const after = isParsedAlert(result) ? result : null;
  const diffs: string[] = [];
  if (!after && before?.amountCents) diffs.push("now unparsed/ignored");
  if (after && !before?.amountCents) diffs.push(`now parses: ${after.kind} ${after.amountCents}¢ ${after.merchantRaw}`);
  if (after && before?.amountCents && Number(before.amountCents) !== after.amountCents) {
    diffs.push(`amount ${before.amountCents}¢ → ${after.amountCents}¢`);
  }
  if (after && before && before.merchantRaw !== after.merchantRaw) diffs.push(`merchant "${before.merchantRaw}" → "${after.merchantRaw}"`);
  if (after && before && before.occurredDate !== after.occurredDate) diffs.push(`date ${before.occurredDate} → ${after.occurredDate}`);
  if (after && before && JSON.stringify(before.accountHint) !== JSON.stringify(after.accountHint)) {
    diffs.push(`account hint ${JSON.stringify(before.accountHint)} → ${JSON.stringify(after.accountHint)}`);
  }
  if (diffs.length === 0) continue;
  changed += 1;
  console.log(`${ev.gmail_message_id} [${ev.status}]: ${diffs.join("; ")}`);

  if (apply && after && ev.transaction_id && ev.amount !== null) {
    if (ev.claimed) {
      console.log("   skipped: reconciled");
      continue;
    }
    if (ev.hand_edited) {
      console.log("   skipped: amount was changed by hand");
      continue;
    }
    const occurredAt = resolveAlertOccurredAt({
      occurredAt: after.occurredAt,
      occurredDate: after.occurredDate,
      emailReceivedAt: payload.date,
      timeZone: String(ev.timezone ?? "America/Denver"),
    });
    await sql.transaction([
      sql`
        UPDATE transactions
           SET amount = ${(after.amountCents / 100).toFixed(2)}::numeric, occurred_at = ${occurredAt}::timestamptz,
               updated_at = now()
         WHERE user_id = ${ev.user_id} AND id = ${ev.transaction_id}
      `,
      sql`
        UPDATE email_events SET parsed = ${JSON.stringify(after)}::jsonb, parser_version = ${parser.version}
         WHERE user_id = ${ev.user_id} AND id = ${ev.id}
      `,
    ]);
    applied += 1;
    console.log("   applied");
  }
}
console.log(`\n${events.length} event(s) checked, ${changed} would change${apply ? `, ${applied} applied` : " (dry run)"}.`);
