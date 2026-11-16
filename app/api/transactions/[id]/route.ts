import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import {
  EXPENSE_SELECT_FIELDS,
  TRANSACTION_JOINS,
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

/** Why an amount changed, for transaction_amount_changes. 'csv' = Reconcile's "Correct to $X & link". */
const AMOUNT_REASONS = new Set(["manual", "csv"]);

export async function PATCH(request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId, actorId } = ctx;

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
      // Choosing a category by hand is an answer (plan §5.5 "Change"): a row
      // that was waiting in To categorize, or carried a guess, becomes
      // confirmed and loses its "unconfirmed" marker. Rows a person already
      // categorized are left exactly as they were apart from the category.
      await sql`
        UPDATE transactions
           SET category = ${category},
               kind = ${category.toLowerCase() === "income" ? "income" : "expense"},
               categorized_by = CASE
                 WHEN review_status = 'needs_review' OR categorized_by IN ('guess', 'rule') THEN 'user'
                 ELSE categorized_by END,
               reviewed_by = CASE
                 WHEN review_status = 'needs_review' OR categorized_by IN ('guess', 'rule')
                 THEN ${actorId}::uuid ELSE reviewed_by END,
               reviewed_at = CASE
                 WHEN review_status = 'needs_review' OR categorized_by IN ('guess', 'rule')
                 THEN now() ELSE reviewed_at END,
               review_status = 'confirmed',
               updated_at = now()
         WHERE user_id = ${userId} AND id = ${id} AND kind <> 'transfer'
      `;
    }

    if (body.amount !== undefined) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
      }
      const reason =
        typeof body.amountReason === "string" && AMOUNT_REASONS.has(body.amountReason)
          ? body.amountReason
          : "manual";
      // The amount history row is written first, while `amount` still holds
      // the old value, and only when it actually changes.
      await sql.transaction([
        sql`
          INSERT INTO transaction_amount_changes
            (user_id, transaction_id, old_amount, new_amount, reason, changed_by)
          SELECT ${userId}::uuid, t.id, t.amount, ${amount}::numeric, ${reason}, ${actorId}::uuid
            FROM transactions t
           WHERE t.user_id = ${userId} AND t.id = ${id} AND t.amount <> ${amount}::numeric
        `,
        sql`
          UPDATE transactions
             SET amount = ${amount}, updated_at = now()
           WHERE user_id = ${userId} AND id = ${id}
        `,
      ]);
    }

    // A transfer's sides — how "Which Venmo account?" is answered. An empty
    // value is ignored rather than clearing a side.
    if (existing[0].kind === "transfer") {
      const from = typeof body.transferFrom === "string" ? body.transferFrom.trim() : "";
      const to = typeof body.transferTo === "string" ? body.transferTo.trim() : "";
      if (from || to) {
        await sql`
          UPDATE transactions
             SET transfer_from = COALESCE(${from || null}, transfer_from),
                 transfer_to = COALESCE(${to || null}, transfer_to),
                 updated_at = now()
           WHERE user_id = ${userId} AND id = ${id}
        `;
        await sql`
          UPDATE transactions
             SET review_status = 'confirmed', reviewed_by = ${actorId}::uuid, reviewed_at = now()
           WHERE user_id = ${userId} AND id = ${id} AND review_status = 'needs_review'
             AND transfer_from IS NOT NULL AND transfer_to IS NOT NULL
        `;
      }
    }

    // Dismiss a "Possible duplicate" flag: both rows are real.
    if (body.clearDuplicate === true) {
      await sql`
        UPDATE transactions SET duplicate_of = NULL, updated_at = now()
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

    // `entered_by` is deliberately not touched by an edit: it records who first
    // logged the row, not who last changed it.
    const fields = existing[0].kind === "transfer" ? TRANSFER_SELECT_FIELDS : EXPENSE_SELECT_FIELDS;
    const rows = (await sql(
      `SELECT ${fields}
       FROM transactions t
       ${TRANSACTION_JOINS}
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
    // Deleting one of a "Possible duplicate" pair resolves the flag on the other.
    await sql`
      UPDATE transactions SET duplicate_of = NULL
       WHERE user_id = ${userId} AND duplicate_of = ${id}
    `;
    return NextResponse.json({ success: true, id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete transaction" },
      { status: 502 },
    );
  }
}
