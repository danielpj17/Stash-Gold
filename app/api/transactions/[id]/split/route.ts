import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { loadMerchantByKey } from "@/lib/email/context";
import { merchantKey } from "@/lib/email/merchantKey";
import { decideCategory } from "@/lib/email/rules";
import type { ParsedAlert } from "@/lib/email/types";
import { selectTransactionRow } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Split back into two" (plan §5.6) — undo a heuristic tip / gas-hold merge.
 *
 * Restores the row's amount from before the merge and re-creates the second
 * purchase from its own email event, which is only possible because raw
 * events are kept. Every heuristic mistake is therefore one tap to undo.
 * One transaction; every statement filters on user_id.
 */
export async function POST(_request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId, actorId } = ctx;
  const id = String(context.params.id ?? "").trim();

  try {
    const rows = (await sql`
      SELECT t.id, t.amount, t.account, t.auto_merged, t.merchant_id,
             c.old_amount, c.email_event_id, e.parsed, e.decision
        FROM transactions t
        JOIN LATERAL (
          SELECT old_amount, email_event_id FROM transaction_amount_changes
           WHERE user_id = t.user_id AND transaction_id = t.id
             AND email_event_id IS NOT NULL AND reason IN ('tip', 'gas_final')
           ORDER BY changed_at DESC LIMIT 1
        ) c ON true
        JOIN email_events e ON e.user_id = t.user_id AND e.id = c.email_event_id
       WHERE t.user_id = ${userId} AND t.id = ${id}
    `) as Array<{
      id: string;
      amount: string;
      account: string | null;
      auto_merged: boolean;
      merchant_id: string | null;
      old_amount: string;
      email_event_id: string;
      parsed: ParsedAlert | null;
      decision: { summary?: { occurredAt?: string } } | null;
    }>;
    const row = rows[0];
    if (!row || !row.auto_merged || !row.parsed) {
      return NextResponse.json({ error: "This transaction wasn't auto-merged" }, { status: 400 });
    }

    const key = merchantKey(row.parsed.merchantRaw);
    const guess = decideCategory(await loadMerchantByKey(sql, userId, key), key);
    const newId = randomUUID();
    const secondAmount = (row.parsed.amountCents / 100).toFixed(2);
    const occurredAt = row.decision?.summary?.occurredAt ?? new Date().toISOString();

    await sql.transaction([
      sql`
        INSERT INTO transaction_amount_changes
          (user_id, transaction_id, old_amount, new_amount, reason, changed_by)
        VALUES (${userId}::uuid, ${id}, ${row.amount}::numeric, ${row.old_amount}::numeric, 'split_back', ${actorId}::uuid)
      `,
      sql`
        UPDATE transactions
           SET amount = ${row.old_amount}::numeric, original_amount = NULL, auto_merged = false, updated_at = now()
         WHERE user_id = ${userId} AND id = ${id}
      `,
      sql`
        INSERT INTO transactions (
          id, user_id, entered_by, kind, occurred_at, amount, category, description, account,
          source, review_status, categorized_by, is_pending, merchant_id, email_event_id
        )
        SELECT ${newId}, ${userId}::uuid, NULL, 'expense', ${occurredAt}::timestamptz,
               ${secondAmount}::numeric, ${guess.category}, t.description, t.account,
               'email', ${guess.reviewStatus}, ${guess.categorizedBy}, ${row.parsed.isPending},
               t.merchant_id, ${row.email_event_id}::uuid
          FROM transactions t
         WHERE t.user_id = ${userId} AND t.id = ${id}
      `,
      sql`
        UPDATE email_events
           SET status = 'created', status_reason = 'split_back', transaction_id = ${newId}, processed_at = now()
         WHERE user_id = ${userId} AND id = ${row.email_event_id}::uuid
      `,
    ]);

    return NextResponse.json({
      restored: await selectTransactionRow(sql, userId, id, "expense"),
      created: await selectTransactionRow(sql, userId, newId, "expense"),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to split" },
      { status: 502 },
    );
  }
}
