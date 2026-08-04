import { createHash, randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { getSql, type Sql } from "@/lib/db";

export type ApiUser = {
  sql: Sql;
  userId: string;
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

async function userIdFromBearer(req: NextRequest, sql: Sql): Promise<string | null> {
  const header = (req.headers.get("authorization") ?? "").trim();
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;

  // UPDATE ... RETURNING refreshes last_used_at in the same round trip.
  const rows = (await sql`
    UPDATE user_tokens
       SET last_used_at = now()
     WHERE token_hash = ${hashIngestToken(match[1])}
       AND revoked_at IS NULL
    RETURNING user_id
  `) as Array<{ user_id: string }>;

  return rows[0]?.user_id ?? null;
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
    const tokenUser = await userIdFromBearer(req, sql);
    if (tokenUser) return { sql, userId: tokenUser, via: "token" };
  }

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return { sql, userId, via: "session" };
}

export function isErrorResponse(value: ApiUser | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
}
