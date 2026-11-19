import { NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Dismiss" on Needs a look: an email a person has looked at and doesn't want
 * anything from — a hand-forwarded alert (always unauthenticated; its purchase
 * was logged by hand), or one Stash can't read that isn't a transaction.
 *
 * Only `unparsed` and `unauthenticated`. Nothing is deleted and no row is
 * touched: the email stays stored, now `ignored`, so Re-read leaves it alone.
 * An `unknown_account` email is answered by assigning an account instead.
 */
export async function POST(_request: Request, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;
  const id = String(context.params.id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  try {
    const rows = (await sql`
      UPDATE email_events
         SET status = 'ignored', status_reason = 'dismissed_by_person', processed_at = now()
       WHERE user_id = ${userId} AND id = ${id}::uuid AND status IN ('unparsed', 'unauthenticated')
      RETURNING id
    `) as Array<{ id: string }>;
    if (rows.length === 0) {
      return NextResponse.json({ error: "Only an email Stash couldn't read or verify can be dismissed." }, { status: 409 });
    }
    return NextResponse.json({ status: "ignored" });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to dismiss" }, { status: 502 });
  }
}
