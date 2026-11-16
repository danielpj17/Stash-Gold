import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { processEvent } from "@/lib/email/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-read: re-run `unparsed` and `unknown_account` events through the current
 * parsers (after a parser fix, or after assigning an account).
 *
 * Never `unauthenticated` (a spoof stays a spoof) and never `shadow` (those
 * purchases were logged by hand; each event's mode_at_receipt also keeps a
 * re-read from turning them live). Body: { ids?: string[] } to limit it.
 * Oldest first, at most 100 per call, so follow-ups meet their purchases.
 */
export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { ids?: unknown } = {};
  try {
    body = (await request.json()) as { ids?: unknown };
  } catch {
    /* re-read everything eligible */
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string").slice(0, 100) : [];

  try {
    const rows = (await sql`
      SELECT id FROM email_events
       WHERE user_id = ${userId}
         AND status IN ('unparsed', 'unknown_account', 'received')
         AND (cardinality(${ids}::uuid[]) = 0 OR id = ANY(${ids}::uuid[]))
       ORDER BY received_at ASC
       LIMIT 100
    `) as Array<{ id: string }>;

    const outcomes: Record<string, number> = {};
    for (const row of rows) {
      const result = await processEvent(sql, userId, row.id);
      outcomes[result.status] = (outcomes[result.status] ?? 0) + 1;
    }
    return NextResponse.json({ processed: rows.length, outcomes });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Re-read failed" },
      { status: 502 },
    );
  }
}
