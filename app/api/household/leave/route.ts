import { NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Leave a household you were invited into.
 *
 * Self-service on purpose: the owner can remove you, and you can walk away,
 * without either needing the other. Nothing is deleted — you simply stop
 * resolving to their scope and land back on an empty Stash of your own. Rows
 * you entered keep your name, because `entered_by` points at your user row and
 * that row is untouched.
 *
 * `data_owner_id IS NOT NULL` in the WHERE is what stops an owner from
 * "leaving" their own data behind and orphaning the member.
 */
export async function POST() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, actorId } = ctx;

  try {
    const rows = (await sql`
      UPDATE users SET data_owner_id = NULL
       WHERE id = ${actorId} AND data_owner_id IS NOT NULL
      RETURNING id
    `) as Array<{ id: string }>;

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "This Stash is your own — there's nothing to leave." },
        { status: 400 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to leave" },
      { status: 502 },
    );
  }
}
