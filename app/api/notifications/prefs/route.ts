import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which accounts' "categorize this" pushes reach the signed-in PERSON.
 *
 * Rows scope on `actorId` (each person edits only their own), but the
 * accounts listed are the household's, so the join is on `userId`. An account
 * with no row is OFF for that person — a new account is on only for whoever
 * created it (POST /api/accounts writes that row).
 */
export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId, actorId } = ctx;

  try {
    const rows = (await sql`
      SELECT a.id, a.name, COALESCE(np.enabled, false) AS enabled
        FROM financial_accounts a
        LEFT JOIN notification_prefs np ON np.account_id = a.id AND np.user_id = ${actorId}::uuid
       WHERE a.user_id = ${userId} AND a.deleted_at IS NULL
       ORDER BY a.sort_order ASC, a.name ASC
    `) as Array<{ id: string; name: string; enabled: boolean }>;
    return NextResponse.json({ accounts: rows.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled === true })) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 502 });
  }
}

/** { accountId, enabled } */
export async function PUT(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId, actorId } = ctx;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  if (!accountId || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "accountId and enabled are required" }, { status: 400 });
  }

  try {
    // Only an account in this person's household can be subscribed to.
    const rows = (await sql`
      INSERT INTO notification_prefs (user_id, account_id, enabled, updated_at)
      SELECT ${actorId}::uuid, a.id, ${body.enabled}, now()
        FROM financial_accounts a
       WHERE a.user_id = ${userId} AND a.id = ${accountId}::uuid
      ON CONFLICT (user_id, account_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
      RETURNING account_id
    `) as Array<{ account_id: string }>;
    if (rows.length === 0) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 502 });
  }
}
