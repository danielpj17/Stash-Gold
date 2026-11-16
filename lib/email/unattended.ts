import type { Sql } from "@/lib/db";

/**
 * The unattended settle (plan §5.9). Called from the poller's heartbeat and
 * lazily from every read of the To categorize queue, so no cron (and no
 * cross-scope query) is ever needed. Always scoped to ONE data scope.
 *
 *   - Overdue, unsettled needs_review expenses on `auto_guess` accounts that
 *     carry a provisional category are confirmed as-is. `categorized_by` stays
 *     'guess', so the row keeps its "unconfirmed" marker, and because the
 *     category doesn't change the budget doesn't move (D2).
 *   - Everything else overdue is marked settled and stays in the queue, with
 *     no second push.
 *   - No guess means it always stays in review, whatever the setting.
 */
export async function settleUnattended(sql: Sql, userId: string): Promise<{ confirmed: number; settled: number }> {
  const [confirmed, settled] = await sql.transaction([
    sql`
      UPDATE transactions t
         SET review_status = 'confirmed',
             unattended_settled_at = now(),
             updated_at = now()
        FROM financial_accounts a
       WHERE t.user_id = ${userId}
         AND a.user_id = ${userId}
         AND a.id::text = t.account
         AND a.unattended_action = 'auto_guess'
         AND t.kind = 'expense'
         AND t.review_status = 'needs_review'
         AND t.unattended_settled_at IS NULL
         AND t.unattended_due_at IS NOT NULL
         AND t.unattended_due_at <= now()
         AND t.category IS NOT NULL
         AND t.categorized_by = 'guess'
      RETURNING t.id
    `,
    sql`
      UPDATE transactions
         SET unattended_settled_at = now()
       WHERE user_id = ${userId}
         AND review_status = 'needs_review'
         AND unattended_settled_at IS NULL
         AND unattended_due_at IS NOT NULL
         AND unattended_due_at <= now()
      RETURNING id
    `,
  ]);
  return {
    confirmed: Array.isArray(confirmed) ? confirmed.length : 0,
    settled: Array.isArray(settled) ? settled.length : 0,
  };
}
