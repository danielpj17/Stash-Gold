import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import {
  EXPENSE_SELECT_FIELDS,
  TRANSACTION_JOINS,
  TRANSFER_SELECT_FIELDS,
  insertOrLinkTransaction,
  insertTransaction,
  parseTransactionInput,
  stripDateIfDisabled,
  type TransactionRow,
} from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Replaces the Google Sheets proxy.
 *
 * Rows come back in exactly the camelCase shape `services/transactionsApi.ts` already
 * normalizes (rowId / expenseType / transferRowId / ...), so its alias table
 * passes them through untouched and none of the nine consumers change.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  const kind = request.nextUrl.searchParams.get("kind") === "transfers" ? "transfers" : "expenses";

  try {
    const rows =
      kind === "transfers"
        ? ((await sql(
            // Scoped to the household, not the acting user: in a shared Stash
            // both people get one combined list, which is the whole point.
            `SELECT ${TRANSFER_SELECT_FIELDS}
             FROM transactions t
             ${TRANSACTION_JOINS}
             WHERE t.user_id = $1 AND t.kind = 'transfer'
             ORDER BY t.created_at ASC, t.id ASC`,
            [userId],
          )) as TransactionRow[])
        : ((await sql(
            // Sheets returned rows in append order, and some client code assumes
            // newest-last, so order by created_at rather than occurred_at —
            // back-dated entries must not jump the queue.
            `SELECT ${EXPENSE_SELECT_FIELDS}
             FROM transactions t
             ${TRANSACTION_JOINS}
             WHERE t.user_id = $1 AND t.kind IN ('expense', 'income')
             ORDER BY t.created_at ASC, t.id ASC`,
            [userId],
          )) as TransactionRow[]);

    return NextResponse.json(rows.map(stripDateIfDisabled));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load transactions" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId, actorId } = ctx;

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
    // Returning the created row (with its id) is what lets the reconcile page
    // drop its old poll-and-diff loop for discovering the new row.
    //
    // insertOrLinkTransaction is a plain insert unless email sync is live and a
    // card alert already recorded this purchase (plan §5.7). The extra fields
    // are additive: callers that only read the row are unaffected.
    //
    // Reconcile's Quick Add sends `source: "csv"`: it creates an entry FOR a
    // statement line and claims it straight away, so it must always insert a
    // new row — absorbing into an email row would hand back a different row
    // (and amount) than the claim it's about to write expects.
    const raw = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const fromReconcile = raw.source === "csv";
    const result = fromReconcile
      ? {
          row: await insertTransaction(sql, userId, parsed, actorId, { source: "csv" }),
          absorbed: null,
          possibleDuplicateOf: null,
        }
      : await insertOrLinkTransaction(sql, userId, parsed, actorId, {
          source: "manual",
          keepSeparate: raw.keepSeparate === true,
        });
    return NextResponse.json(
      {
        ...result.row,
        matchedEmail: result.absorbed,
        possibleDuplicateOf: result.possibleDuplicateOf,
      },
      { status: result.absorbed ? 200 : 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save transaction" },
      { status: 502 },
    );
  }
}
