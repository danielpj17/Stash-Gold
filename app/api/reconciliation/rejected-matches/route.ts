import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pairs the user explicitly disconnected, so matching stops re-proposing them.
 *
 * A rejection is the inverse of a claim link and is keyed the same way: on the
 * PAIR, never on either side alone. Rejecting A->X leaves A free to match Y and
 * X free to match B, which is the whole point when several same-amount
 * subscriptions share a date.
 *
 * Recording one is normally a side effect of Disconnect; clearing one is a side
 * effect of claiming that pair (handled inside the claims and transfer-claims
 * POST routes, not here, so it can't be forgotten at a call site).
 */

type RejectedRow = {
  bank_hash: string;
  sheet_name: string;
  sheet_row_id: string;
  account_name: string | null;
};

function readPair(body: {
  bankHash?: unknown;
  sheetName?: unknown;
  sheetRowId?: unknown;
  accountName?: unknown;
}): { bankHash: string; sheetName: string; sheetRowId: string; accountName: string } {
  return {
    bankHash: typeof body.bankHash === "string" ? body.bankHash.trim() : "",
    sheetName:
      typeof body.sheetName === "string" && body.sheetName.trim() ? body.sheetName.trim() : "Expenses",
    sheetRowId: typeof body.sheetRowId === "string" ? body.sheetRowId.trim() : "",
    accountName: typeof body.accountName === "string" ? body.accountName.trim() : "",
  };
}

export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    const rows = (await sql`
      SELECT bank_hash, sheet_name, sheet_row_id, account_name
      FROM reconciliation_rejected_matches
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `) as RejectedRow[];

    return NextResponse.json({
      rejections: rows.map((row) => ({
        bankHash: row.bank_hash,
        sheetName: row.sheet_name,
        sheetRowId: row.sheet_row_id,
        accountName: row.account_name,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch rejected matches" },
      { status: 502 },
    );
  }
}

/**
 * Record one or more rejected pairs.
 *
 * Accepts `pairs: [...]` for the usual case — Disconnect removes every link on a
 * bank hash at once, and each of those links is its own rejection — or a single
 * pair inline.
 */
export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: {
    pairs?: unknown;
    bankHash?: unknown;
    sheetName?: unknown;
    sheetRowId?: unknown;
    accountName?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawPairs = Array.isArray(body.pairs) ? body.pairs : [body];
  const pairs = rawPairs
    .filter((pair): pair is Record<string, unknown> => Boolean(pair) && typeof pair === "object")
    .map((pair) => readPair(pair))
    .filter((pair) => pair.bankHash && pair.sheetRowId);

  if (pairs.length === 0) {
    return NextResponse.json(
      { error: "At least one pair with bankHash and sheetRowId is required" },
      { status: 400 },
    );
  }

  try {
    await sql.transaction(
      pairs.map(
        (pair) => sql`
          INSERT INTO reconciliation_rejected_matches (
            user_id, bank_hash, sheet_name, sheet_row_id, account_name
          )
          VALUES (
            ${userId}::uuid,
            ${pair.bankHash},
            ${pair.sheetName},
            ${pair.sheetRowId},
            ${pair.accountName || null}
          )
          ON CONFLICT (user_id, bank_hash, sheet_name, sheet_row_id)
          DO UPDATE SET account_name = EXCLUDED.account_name, created_at = now()
        `,
      ),
    );

    return NextResponse.json({ success: true, rejected: pairs.length, pairs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to record rejected match" },
      { status: 502 },
    );
  }
}

/**
 * Clear a rejection.
 *
 * With `sheetRowId`, clears that one pair. With only `bankHash`, clears every
 * rejection on that bank line — what "let this line match freely again" means.
 */
export async function DELETE(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { bankHash?: unknown; sheetName?: unknown; sheetRowId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { bankHash, sheetName, sheetRowId } = readPair(body);
  if (!bankHash) {
    return NextResponse.json({ error: "bankHash is required" }, { status: 400 });
  }

  try {
    if (sheetRowId) {
      await sql`
        DELETE FROM reconciliation_rejected_matches
        WHERE user_id = ${userId}
          AND bank_hash = ${bankHash}
          AND sheet_name = ${sheetName}
          AND sheet_row_id = ${sheetRowId}
      `;
    } else {
      await sql`
        DELETE FROM reconciliation_rejected_matches
        WHERE user_id = ${userId} AND bank_hash = ${bankHash}
      `;
    }

    return NextResponse.json({ success: true, bankHash });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to clear rejected match" },
      { status: 502 },
    );
  }
}
