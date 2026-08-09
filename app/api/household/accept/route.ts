import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { hasOwnData, hashInviteToken, normalizeEmail } from "@/lib/household";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type InviteRow = {
  id: string;
  owner_user_id: string;
  email: string;
  owner_name: string | null;
  owner_email: string | null;
  owner_data_owner_id: string | null;
};

/**
 * Look up an invite by its raw token and say whether the signed-in user can
 * take it. Used by both GET (to render the page) and POST (to act).
 *
 * Ordering matters: the email check comes before anything else that could leak
 * information, and every failure returns the same shape.
 */
async function evaluate(
  sql: Parameters<typeof hasOwnData>[0],
  token: string,
  actorId: string,
  actorEmail: string,
): Promise<
  | { ok: true; invite: InviteRow; inviterLabel: string }
  | { ok: false; status: number; error: string }
> {
  if (!token) return { ok: false, status: 400, error: "Missing invitation token" };

  const rows = (await sql`
    SELECT i.id, i.owner_user_id, i.email,
           o.name  AS owner_name,
           o.email AS owner_email,
           o.data_owner_id AS owner_data_owner_id
    FROM household_invites i
    JOIN users o ON o.id = i.owner_user_id
    WHERE i.token_hash = ${hashInviteToken(token)}
      AND i.accepted_at IS NULL
      AND i.revoked_at IS NULL
      AND i.expires_at > now()
  `) as InviteRow[];

  const invite = rows[0];
  if (!invite) {
    return {
      ok: false,
      status: 404,
      error: "This invitation has expired or already been used. Ask for a new one.",
    };
  }

  // THE check that makes "only that email is allowed" true. The token alone is
  // never sufficient, so a forwarded email can't be redeemed by whoever
  // receives it.
  if (normalizeEmail(actorEmail) !== normalizeEmail(invite.email)) {
    return {
      ok: false,
      status: 403,
      error: `This invitation was sent to ${invite.email}. Sign in with that address to accept it.`,
    };
  }

  // No chains: an owner who is themselves a member would make `data_owner_id` a
  // linked list, and every read in the app assumes one hop.
  if (invite.owner_data_owner_id) {
    return {
      ok: false,
      status: 409,
      error: "That Stash is itself shared from someone else, so it can't be shared again.",
    };
  }

  if (invite.owner_user_id === actorId) {
    return { ok: false, status: 400, error: "You can't accept your own invitation." };
  }

  // Accepting repoints every read at the owner's scope. Existing data would stay
  // in the database but become invisible, so refuse loudly instead.
  if (await hasOwnData(sql, actorId)) {
    return {
      ok: false,
      status: 409,
      error:
        "This account already has its own Stash data. Joining would hide it, so it has to stay separate for now.",
    };
  }

  return {
    ok: true,
    invite,
    inviterLabel: invite.owner_name?.trim() || invite.owner_email || "Someone",
  };
}

/** Preview an invitation without consuming it, so the page can explain itself. */
export async function GET(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, actorId } = ctx;

  const token = request.nextUrl.searchParams.get("token") ?? "";

  try {
    const me = (await sql`SELECT email FROM users WHERE id = ${actorId}`) as Array<{
      email: string | null;
    }>;
    const result = await evaluate(sql, token, actorId, me[0]?.email ?? "");
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ inviterLabel: result.inviterLabel, email: result.invite.email });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read the invitation" },
      { status: 502 },
    );
  }
}

/** Accept it. Takes effect on the very next request — database sessions re-read
 *  `users` every time, so there is nothing to refresh and nobody to sign out. */
export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, actorId } = ctx;

  let body: { token?: unknown; name?: unknown };
  try {
    body = (await request.json()) as { token?: unknown; name?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  const name = rawName ? rawName.slice(0, 60) : null;

  try {
    const me = (await sql`SELECT email FROM users WHERE id = ${actorId}`) as Array<{
      email: string | null;
    }>;
    const result = await evaluate(sql, token, actorId, me[0]?.email ?? "");
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // One transaction: joining and consuming the invite must not come apart.
    // The WHERE clauses re-assert the preconditions so a double submit is a
    // no-op rather than a second join.
    await sql.transaction([
      sql`
        UPDATE users
           SET data_owner_id = ${result.invite.owner_user_id},
               name = COALESCE(${name}, name)
         WHERE id = ${actorId} AND data_owner_id IS NULL
      `,
      sql`
        UPDATE household_invites
           SET accepted_at = now()
         WHERE id = ${result.invite.id} AND accepted_at IS NULL AND revoked_at IS NULL
      `,
    ]);

    return NextResponse.json({ success: true, inviterLabel: result.inviterLabel });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to accept the invitation" },
      { status: 502 },
    );
  }
}
