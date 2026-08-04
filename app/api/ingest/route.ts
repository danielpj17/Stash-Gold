import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { insertTransaction, parseTransactionInput } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cheap abuse guard without Redis: count this user's very recent inserts. */
const MAX_PER_MINUTE = 30;

/**
 * Log a transaction from the iOS Shortcut — no login, no cookie.
 *
 * A Shortcut is a fixed HTTP request: there's no browser to run an OAuth
 * redirect and no way to prompt for a password, so a long-lived per-user bearer
 * token is the only mechanism that can identify the user with zero interaction.
 *
 * Deliberately token-only: a stolen session cookie can't reach this endpoint,
 * and an ingest token can't be used to mint more tokens (see /api/tokens, which
 * is session-only). The body accepts the aliases the existing Shortcut already
 * sends, so migrating it means changing the URL and adding one header.
 */
export async function POST(request: NextRequest) {
  const ctx = await requireUser(request, { allowBearer: true });
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId, via } = ctx;

  if (via !== "token") {
    return NextResponse.json(
      { error: "Send an ingest token: Authorization: Bearer stsh_…" },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseTransactionInput(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const recent = (await sql`
      SELECT count(*)::int AS n
      FROM transactions
      WHERE user_id = ${userId} AND created_at > now() - interval '1 minute'
    `) as Array<{ n: number }>;
    if (Number(recent[0]?.n ?? 0) >= MAX_PER_MINUTE) {
      return NextResponse.json(
        { error: "Too many transactions in the last minute. Try again shortly." },
        { status: 429 },
      );
    }

    const row = await insertTransaction(sql, userId, parsed);
    return NextResponse.json(
      {
        id: row.rowId ?? row.transferRowId ?? null,
        kind: parsed.kind,
        amount: parsed.amount,
        occurredAt: parsed.occurredAt,
      },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save transaction" },
      { status: 502 },
    );
  }
}
