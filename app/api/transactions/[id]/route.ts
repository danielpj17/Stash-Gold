import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import {
  EXPENSE_SELECT_FIELDS,
  TRANSFER_SELECT_FIELDS,
  stripDateIfDisabled,
  type TransactionRow,
} from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExistingRow = { id: string; kind: string };

/** Anchors a bare YYYY-MM-DD at midday UTC — see resolveOccurredAt in lib/transactions. */
function resolveDate(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function PATCH(request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  const id = String(context.params.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const existing = (await sql`
      SELECT id, kind FROM transactions WHERE user_id = ${userId} AND id = ${id}
    `) as ExistingRow[];
    if (existing.length === 0) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    }

    if (body.date !== undefined) {
      const occurredAt = resolveDate(body.date);
      if (!occurredAt) {
        return NextResponse.json({ error: "date could not be understood" }, { status: 400 });
      }
      await sql`
        UPDATE transactions
           SET occurred_at = ${occurredAt}::timestamptz, updated_at = now()
         WHERE user_id = ${userId} AND id = ${id}
      `;
    }

    if (typeof body.description === "string") {
      await sql`
        UPDATE transactions
           SET description = ${body.description.trim()}, updated_at = now()
         WHERE user_id = ${userId} AND id = ${id}
      `;
    }

    if (typeof body.expenseType === "string" && body.expenseType.trim()) {
      const category = body.expenseType.trim();
      await sql`
        UPDATE transactions
           SET category = ${category},
               kind = ${category.toLowerCase() === "income" ? "income" : "expense"},
               updated_at = now()
         WHERE user_id = ${userId} AND id = ${id} AND kind <> 'transfer'
      `;
    }

    if (body.amount !== undefined) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
      }
      await sql`
        UPDATE transactions
           SET amount = ${amount}, updated_at = now()
         WHERE user_id = ${userId} AND id = ${id}
      `;
    }

    if (typeof body.account === "string") {
      await sql`
        UPDATE transactions
           SET account = ${body.account.trim() || null}, updated_at = now()
         WHERE user_id = ${userId} AND id = ${id} AND kind <> 'transfer'
      `;
    }

    const fields = existing[0].kind === "transfer" ? TRANSFER_SELECT_FIELDS : EXPENSE_SELECT_FIELDS;
    const rows = (await sql(
      `SELECT ${fields}
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       WHERE t.user_id = $1 AND t.id = $2`,
      [userId, id],
    )) as TransactionRow[];

    return NextResponse.json(stripDateIfDisabled(rows[0] ?? {}));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update transaction" },
      { status: 502 },
    );
  }
}

export async function DELETE(_request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  const id = String(context.params.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    // Reconciliation links are left alone on purpose: the app already tolerates
    // a claim pointing at a missing row ("linked sheet row was not found"), and
    // cascading here would silently discard matching work.
    const rows = (await sql`
      DELETE FROM transactions WHERE user_id = ${userId} AND id = ${id} RETURNING id
    `) as Array<{ id: string }>;
    if (rows.length === 0) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete transaction" },
      { status: 502 },
    );
  }
}
