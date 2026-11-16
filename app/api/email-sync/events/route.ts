import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { EVENT_STATUSES } from "@/lib/email/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recent email events — METADATA ONLY. No route ever selects raw_text or
 * raw_html: bank email doesn't leave the server (plan §5.11). Debugging a
 * body uses scripts/export-email-fixture.mjs locally.
 *
 * ?status=unparsed,unknown_account  &limit=50  &before=<ISO created_at>
 */
export async function GET(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  const params = request.nextUrl.searchParams;
  const statuses = (params.get("status") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => (EVENT_STATUSES as readonly string[]).includes(s));
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 50) || 50, 1), 200);
  const beforeRaw = params.get("before");
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw).toISOString() : null;

  try {
    const rows = (await sql`
      SELECT id, gmail_message_id, from_address, forwarded_for, subject, received_at, status,
             status_reason, parser_id, parser_version, error, transaction_id, created_at,
             processed_at, mode_at_receipt, truncated,
             parsed->>'kind' AS alert_kind,
             (parsed->>'amountCents')::int AS amount_cents,
             parsed->>'merchantRaw' AS merchant_raw,
             parsed->'accountHint'->>'last4' AS last4,
             decision->'summary'->>'accountName' AS account_name,
             decision->>'wouldBe' AS would_be,
             decision->>'action' AS action
        FROM email_events
       WHERE user_id = ${userId}
         AND (cardinality(${statuses}::text[]) = 0 OR status = ANY(${statuses}::text[]))
         AND (${before}::timestamptz IS NULL OR created_at < ${before}::timestamptz)
       ORDER BY created_at DESC
       LIMIT ${limit}
    `) as Array<Record<string, unknown>>;

    return NextResponse.json({
      events: rows.map((r) => ({
        id: r.id,
        gmailMessageId: r.gmail_message_id,
        from: r.from_address,
        forwardedFor: r.forwarded_for,
        subject: r.subject,
        receivedAt: r.received_at,
        status: r.status,
        reason: r.status_reason,
        parserId: r.parser_id,
        parserVersion: r.parser_version,
        error: r.error,
        transactionId: r.transaction_id,
        createdAt: r.created_at,
        processedAt: r.processed_at,
        modeAtReceipt: r.mode_at_receipt,
        truncated: r.truncated,
        alertKind: r.alert_kind,
        amountCents: r.amount_cents,
        merchantRaw: r.merchant_raw,
        last4: r.last4,
        accountName: r.account_name,
        wouldBe: r.would_be,
        action: r.action,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load email events" },
      { status: 502 },
    );
  }
}
