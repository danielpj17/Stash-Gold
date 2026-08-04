import { NextRequest, NextResponse } from "next/server";
import { generateIngestToken, isErrorResponse, requireUser } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

function mapRow(row: TokenRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Manage ingest tokens. Session-authenticated ONLY — never bearer.
 *
 * `requireUser()` without `allowBearer` means a leaked ingest token cannot be
 * used to mint further tokens or enumerate existing ones.
 */
export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    // token_hash is never selected — there is nothing useful to do with it and
    // no reason for it to leave the database.
    const rows = (await sql`
      SELECT id, name, prefix, created_at, last_used_at, revoked_at
      FROM user_tokens
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `) as TokenRow[];
    return NextResponse.json({ tokens: rows.map(mapRow) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load tokens" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { name?: unknown } = {};
  try {
    body = (await request.json()) as { name?: unknown };
  } catch {
    // A nameless token is fine; fall through to the default.
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "iOS Shortcut";

  try {
    const { raw, hash, prefix } = generateIngestToken();
    const rows = (await sql`
      INSERT INTO user_tokens (user_id, name, token_hash, prefix)
      VALUES (${userId}::uuid, ${name}, ${hash}, ${prefix})
      RETURNING id, name, prefix, created_at, last_used_at, revoked_at
    `) as TokenRow[];

    // The only time the raw token is ever returned. Only its hash is stored.
    return NextResponse.json({ token: mapRow(rows[0]), rawToken: raw }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create token" },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { id?: unknown };
  try {
    body = (await request.json()) as { id?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    // Revoke rather than delete, so the audit trail (and last_used_at) survives.
    const rows = (await sql`
      UPDATE user_tokens
         SET revoked_at = now()
       WHERE user_id = ${userId} AND id = ${id}::uuid AND revoked_at IS NULL
      RETURNING id
    `) as Array<{ id: string }>;
    if (rows.length === 0) {
      return NextResponse.json({ error: "Token not found or already revoked" }, { status: 404 });
    }
    return NextResponse.json({ success: true, id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to revoke token" },
      { status: 502 },
    );
  }
}
