import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import type { Sql } from "@/lib/db";
import { processEvent } from "@/lib/email/pipeline";
import { parserById } from "@/lib/email/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Chase alerts for card ••4821 (3 emails) — which account?" (plan §5.4).
 *
 * GET groups `unknown_account` events by what identified them. POST assigns
 * one group to an account — setting that account's alert fields — and
 * re-processes those events. That is also the replacement-card flow.
 *
 * Alerts that name no account (Wells Fargo Bill Pay) group as `unnumbered`;
 * assigning that group ticks the account's "Bill Pay comes out of this
 * account" (migration 008) and leaves its last four alone.
 */
export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    const rows = (await sql`
      SELECT parser_id,
             decision->'accountKey'->>'last4' AS last4,
             decision->'accountKey'->>'forwardedFrom' AS forwarded_from,
             COALESCE((decision->'accountKey'->>'unnumbered')::boolean, false) AS unnumbered,
             status_reason,
             count(*)::int AS n,
             max(received_at) AS latest
        FROM email_events
       WHERE user_id = ${userId} AND status = 'unknown_account'
       GROUP BY 1, 2, 3, 4, 5
       ORDER BY latest DESC
    `) as Array<{
      parser_id: string | null;
      last4: string | null;
      forwarded_from: string | null;
      unnumbered: boolean;
      status_reason: string | null;
      n: number;
      latest: string;
    }>;
    return NextResponse.json({
      groups: rows.map((r) => ({
        parserId: r.parser_id,
        parserLabel: parserById(r.parser_id)?.label ?? r.parser_id,
        last4: r.last4,
        forwardedFrom: r.forwarded_from,
        unnumbered: r.unnumbered === true,
        unnumberedLabel: parserById(r.parser_id)?.unnumbered?.label ?? null,
        reason: r.status_reason,
        count: Number(r.n),
        latest: r.latest,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load unknown accounts" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parser = parserById(typeof body.parserId === "string" ? body.parserId : null);
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const last4 = typeof body.last4 === "string" && /^\d{4}$/.test(body.last4) ? body.last4 : null;
  const forwardedFrom =
    typeof body.forwardedFrom === "string" && body.forwardedFrom.includes("@")
      ? body.forwardedFrom.trim().toLowerCase()
      : null;
  const unnumbered = body.unnumbered === true;
  if (!parser || !accountId) {
    return NextResponse.json({ error: "parserId and accountId are required" }, { status: 400 });
  }
  if (unnumbered) {
    if (!parser.unnumbered) {
      return NextResponse.json({ error: "These alerts always name an account." }, { status: 400 });
    }
    return assignUnnumbered(sql, userId, parser.id, accountId);
  }
  if (parser.accountKey === "last4" ? !last4 : !forwardedFrom) {
    return NextResponse.json(
      { error: parser.accountKey === "last4" ? "last4 is required" : "forwardedFrom is required" },
      { status: 400 },
    );
  }

  try {
    // user_id in the WHERE is what makes another scope's account a no-op.
    const updated = (await sql`
      UPDATE financial_accounts
         SET alert_source = ${parser.id},
             alert_last4 = ${parser.accountKey === "last4" ? last4 : null},
             alert_forwarded_from = ${parser.accountKey === "forwarded_from" ? forwardedFrom : null}
       WHERE user_id = ${userId} AND id = ${accountId}::uuid AND deleted_at IS NULL
      RETURNING id
    `) as Array<{ id: string }>;
    if (updated.length === 0) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    const events = (await sql`
      SELECT id FROM email_events
       WHERE user_id = ${userId} AND status = 'unknown_account' AND parser_id = ${parser.id}
         AND (
           (${last4}::text IS NOT NULL AND decision->'accountKey'->>'last4' = ${last4})
           OR (${forwardedFrom}::text IS NOT NULL AND decision->'accountKey'->>'forwardedFrom' = ${forwardedFrom})
         )
       ORDER BY received_at ASC
       LIMIT 200
    `) as Array<{ id: string }>;

    const outcomes: Record<string, number> = {};
    for (const ev of events) {
      const result = await processEvent(sql, userId, ev.id);
      outcomes[result.status] = (outcomes[result.status] ?? 0) + 1;
    }
    return NextResponse.json({ assigned: true, processed: events.length, outcomes });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to assign account";
    const conflict = message.toLowerCase().includes("unique");
    return NextResponse.json(
      { error: conflict ? "Another account already receives those alerts." : message },
      { status: conflict ? 409 : 502 },
    );
  }
}

/**
 * "Wells Fargo Bill Pay (2 emails) — which account?": tick that account's
 * no-account role for this source, then re-read the waiting emails. The
 * account keeps its own last four when it already reads this source's
 * alerts; switching it from another source clears the old source's keys.
 */
async function assignUnnumbered(sql: Sql, userId: string, parserId: string, accountId: string) {
  try {
    // user_id in every WHERE is what makes another scope's account a no-op.
    const updated = (await sql.transaction([
      sql`
        UPDATE financial_accounts SET alert_unnumbered = false
         WHERE user_id = ${userId} AND alert_source = ${parserId} AND alert_unnumbered
           AND id <> ${accountId}::uuid
      `,
      sql`
        UPDATE financial_accounts
           SET alert_last4 = CASE WHEN alert_source = ${parserId} THEN alert_last4 ELSE NULL END,
               alert_forwarded_from = CASE WHEN alert_source = ${parserId} THEN alert_forwarded_from ELSE NULL END,
               alert_source = ${parserId},
               alert_unnumbered = true
         WHERE user_id = ${userId} AND id = ${accountId}::uuid AND deleted_at IS NULL
        RETURNING id
      `,
    ])) as [unknown, Array<{ id: string }>];
    if (updated[1].length === 0) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    const events = (await sql`
      SELECT id FROM email_events
       WHERE user_id = ${userId} AND status = 'unknown_account' AND parser_id = ${parserId}
         AND (decision->'accountKey'->>'unnumbered')::boolean IS TRUE
       ORDER BY received_at ASC
       LIMIT 200
    `) as Array<{ id: string }>;

    const outcomes: Record<string, number> = {};
    for (const ev of events) {
      const result = await processEvent(sql, userId, ev.id);
      outcomes[result.status] = (outcomes[result.status] ?? 0) + 1;
    }
    return NextResponse.json({ assigned: true, processed: events.length, outcomes });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to assign account";
    const conflict = message.toLowerCase().includes("unique");
    return NextResponse.json(
      { error: conflict ? "Another account already receives those alerts." : message },
      { status: conflict ? 409 : 502 },
    );
  }
}
