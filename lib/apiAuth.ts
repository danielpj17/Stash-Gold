import { createHash, randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { getSql, type Sql } from "@/lib/db";

/**
 * Identity comes in two parts, and conflating them is the one way this feature
 * breaks quietly.
 *
 * `userId` is the DATA SCOPE. In a shared household it is the owner's id for
 * both people, which is what makes every existing `WHERE user_id = …` return
 * one combined view with no query changes anywhere.
 *
 * `actorId` is the PERSON. It is the signed-in user (or the owner of the ingest
 * token). Use it only for attribution and for resources that belong to a person
 * rather than to a household.
 */
export type ApiUser = {
  sql: Sql;
  /** The data scope. Every query over user data filters on THIS. */
  userId: string;
  /**
   * Who is acting. NEVER put this in a WHERE clause over user data — doing so
   * would partition a household and hide one spouse's rows from the other.
   * Legitimate uses: `transactions.entered_by`, and `/api/tokens`.
   */
  actorId: string;
  /** How the caller proved who they are. */
  via: "session" | "token";
};

/**
 * Ingest tokens are 256 bits of CSPRNG output, so there is nothing to
 * brute-force and a plain SHA-256 is the right hash — the same reasoning
 * behind GitHub personal access tokens. A slow KDF would only add CPU to
 * every Shortcut request.
 */
export function hashIngestToken(raw: string): string {
  return createHash("sha256").update(raw.trim()).digest("hex");
}

/** `stsh_` prefix keeps tokens greppable in logs and scannable by secret detectors. */
export function generateIngestToken(): { raw: string; hash: string; prefix: string } {
  const raw = `stsh_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashIngestToken(raw), prefix: raw.slice(0, 13) };
}

/**
 * Resolve an ingest token to both ids in one round trip.
 *
 * `user_tokens.user_id` is the ACTOR — tokens belong to a person, so each
 * spouse's Shortcut identifies them individually. The household scope comes
 * from joining through to `users.data_owner_id`, which is why the Shortcut
 * itself needed no changes when sharing was added.
 */
async function identityFromBearer(
  req: NextRequest,
  sql: Sql,
): Promise<{ userId: string; actorId: string } | null> {
  const header = (req.headers.get("authorization") ?? "").trim();
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;

  // UPDATE ... RETURNING refreshes last_used_at in the same round trip.
  const rows = (await sql`
    UPDATE user_tokens t
       SET last_used_at = now()
      FROM users u
     WHERE t.token_hash = ${hashIngestToken(match[1])}
       AND t.revoked_at IS NULL
       AND u.id = t.user_id
    RETURNING t.user_id AS actor_id,
              COALESCE(u.data_owner_id, u.id) AS owner_id
  `) as Array<{ actor_id: string; owner_id: string }>;

  const row = rows[0];
  return row ? { userId: row.owner_id, actorId: row.actor_id } : null;
}

/**
 * Resolves the acting user for an API route. Returns a NextResponse on
 * failure so callers can `return` it directly:
 *
 *   const ctx = await requireUser();
 *   if (isErrorResponse(ctx)) return ctx;
 *   const { sql, userId } = ctx;
 *
 * NEVER accept a user id from the request body or query string. The reconcile
 * page splits one logical save across many independent HTTP requests, so
 * identity has to be re-derived server-side on every one of them.
 *
 * `userId` is the data scope and `actorId` is the person — see ApiUser. For a
 * solo user they are identical, which is why destructuring just `userId`
 * remains correct in almost every route.
 */
export async function requireUser(
  req?: NextRequest,
  opts: { allowBearer?: boolean } = {},
): Promise<ApiUser | NextResponse> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }
  const sql = getSql();

  if (opts.allowBearer && req) {
    const identity = await identityFromBearer(req, sql);
    if (identity) return { sql, ...identity, via: "token" };
  }

  const session = await auth();
  const actorId = session?.user?.id;
  if (!actorId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // dataOwnerId rides along on the session for free: database sessions re-read
  // `users` on every request and the adapter does SELECT *, so this needs no
  // extra query and cannot go stale — accepting an invite takes effect on the
  // very next request.
  return { sql, userId: session.user.dataOwnerId ?? actorId, actorId, via: "session" };
}

export function isErrorResponse(value: ApiUser | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
}
