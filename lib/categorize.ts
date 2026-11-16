import type { Sql } from "@/lib/db";

/**
 * Shared shapes for To categorize (plan §5.5, §5.10). Server-only reads, all
 * scoped on the data scope `userId`. `reviewedByName` follows the same rule
 * as `enteredByName`: shown only when the Stash is actually shared and that
 * person set a name — never a guessed name.
 */

export type QueueItem = {
  type: "transaction";
  id: string;
  kind: "expense" | "income" | "transfer";
  amount: number;
  originalAmount: number | null;
  occurredAt: string;
  date: string;
  description: string;
  account: string | null;
  transferFrom: string | null;
  transferTo: string | null;
  category: string | null;
  categorizedBy: string | null;
  reviewStatus: "needs_review" | "confirmed";
  isPending: boolean;
  autoMerged: boolean;
  duplicateOf: string | null;
  settled: boolean;
  merchant: {
    id: string;
    displayName: string;
    mode: string;
    shortlist: string[];
    defaultCategory: string | null;
  } | null;
};

export type AmbiguousItem = {
  type: "ambiguous";
  id: string;
  receivedAt: string;
  amountCents: number | null;
  merchantName: string | null;
  accountName: string | null;
  candidates: Array<{ id: string; amount: number; date: string; description: string }>;
};

type TxRow = {
  id: string;
  kind: string;
  amount: string | number;
  original_amount: string | number | null;
  occurred_at: string | Date;
  local_date: string;
  description: string;
  account: string | null;
  transfer_from: string | null;
  transfer_to: string | null;
  category: string | null;
  categorized_by: string | null;
  review_status: string;
  is_pending: boolean;
  auto_merged: boolean;
  duplicate_of: string | null;
  unattended_settled_at: string | null;
  m_id: string | null;
  m_name: string | null;
  m_mode: string | null;
  m_shortlist: string[] | null;
  m_default: string | null;
};

export function mapQueueRow(r: TxRow): QueueItem {
  return {
    type: "transaction",
    id: r.id,
    kind: r.kind === "income" || r.kind === "transfer" ? r.kind : "expense",
    amount: Number(r.amount),
    originalAmount: r.original_amount === null ? null : Number(r.original_amount),
    occurredAt: new Date(r.occurred_at).toISOString(),
    date: r.local_date,
    description: r.description,
    account: r.account,
    transferFrom: r.transfer_from,
    transferTo: r.transfer_to,
    category: r.category,
    categorizedBy: r.categorized_by,
    reviewStatus: r.review_status === "needs_review" ? "needs_review" : "confirmed",
    isPending: r.is_pending === true,
    autoMerged: r.auto_merged === true,
    duplicateOf: r.duplicate_of,
    settled: r.unattended_settled_at !== null,
    merchant: r.m_id
      ? {
          id: r.m_id,
          displayName: r.m_name ?? "",
          mode: r.m_mode ?? "ask_all",
          shortlist: Array.isArray(r.m_shortlist) ? r.m_shortlist : [],
          defaultCategory: r.m_default,
        }
      : null,
  };
}

/** The columns mapQueueRow reads. Callers append their own WHERE. */
export const QUEUE_SELECT = `
  SELECT t.id, t.kind, t.amount, t.original_amount, t.occurred_at,
         to_char(t.occurred_at AT TIME ZONE u.timezone, 'YYYY-MM-DD') AS local_date,
         t.description, t.account, t.transfer_from, t.transfer_to, t.category,
         t.categorized_by, t.review_status, t.is_pending, t.auto_merged, t.duplicate_of,
         t.unattended_settled_at,
         m.id AS m_id, m.display_name AS m_name, m.mode AS m_mode, m.shortlist AS m_shortlist,
         m.default_category AS m_default
    FROM transactions t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN merchants m ON m.user_id = t.user_id AND m.id = t.merchant_id
`;

export async function loadQueue(sql: Sql, userId: string): Promise<{
  needsReview: QueueItem[];
  guessed: QueueItem[];
  duplicates: QueueItem[];
  ambiguous: AmbiguousItem[];
}> {
  const [needsReview, guessed, duplicates, ambiguous] = await Promise.all([
    sql(`${QUEUE_SELECT} WHERE t.user_id = $1 AND t.review_status = 'needs_review' ORDER BY t.occurred_at DESC LIMIT 300`, [
      userId,
    ]) as unknown as Promise<TxRow[]>,
    // Guessed: any row whose category no person chose — waiting, or filed by
    // the unattended rule. Last 60 days so the chip stays a working list.
    sql(
      `${QUEUE_SELECT} WHERE t.user_id = $1 AND t.categorized_by = 'guess'
         AND t.occurred_at > now() - interval '60 days' ORDER BY t.occurred_at DESC LIMIT 300`,
      [userId],
    ) as unknown as Promise<TxRow[]>,
    sql(`${QUEUE_SELECT} WHERE t.user_id = $1 AND t.duplicate_of IS NOT NULL ORDER BY t.occurred_at DESC LIMIT 100`, [
      userId,
    ]) as unknown as Promise<TxRow[]>,
    sql`
      SELECT e.id, e.received_at, (e.parsed->>'amountCents')::int AS amount_cents,
             e.decision->'summary'->>'merchantName' AS merchant_name,
             e.decision->'summary'->>'accountName' AS account_name,
             e.decision->'candidateIds' AS candidate_ids
        FROM email_events e
       WHERE e.user_id = ${userId} AND e.status = 'ambiguous'
       ORDER BY e.received_at DESC
       LIMIT 50
    ` as unknown as Promise<
      Array<{
        id: string;
        received_at: string;
        amount_cents: number | null;
        merchant_name: string | null;
        account_name: string | null;
        candidate_ids: string[] | null;
      }>
    >,
  ]);

  const candidateIds = [...new Set(ambiguous.flatMap((a) => (Array.isArray(a.candidate_ids) ? a.candidate_ids : [])))];
  const candidateRows = candidateIds.length
    ? ((await sql`
        SELECT t.id, t.amount, t.description,
               to_char(t.occurred_at AT TIME ZONE u.timezone, 'YYYY-MM-DD') AS local_date
          FROM transactions t JOIN users u ON u.id = t.user_id
         WHERE t.user_id = ${userId} AND t.id = ANY(${candidateIds}::text[])
      `) as Array<{ id: string; amount: string; description: string; local_date: string }>)
    : [];
  const byId = new Map(candidateRows.map((r) => [r.id, r]));

  return {
    needsReview: needsReview.map(mapQueueRow),
    guessed: guessed.map(mapQueueRow),
    duplicates: duplicates.map(mapQueueRow),
    ambiguous: ambiguous.map((a) => ({
      type: "ambiguous",
      id: a.id,
      receivedAt: new Date(a.received_at).toISOString(),
      amountCents: a.amount_cents,
      merchantName: a.merchant_name,
      accountName: a.account_name,
      candidates: (a.candidate_ids ?? [])
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r) => ({ id: r.id, amount: Number(r.amount), date: r.local_date, description: r.description })),
    })),
  };
}

/** Name to show for whoever answered, under the enteredByName rule. */
export async function reviewerName(sql: Sql, userId: string, reviewerId: string | null): Promise<string | null> {
  if (!reviewerId) return null;
  const rows = (await sql`
    SELECT CASE WHEN EXISTS (SELECT 1 FROM users m WHERE m.data_owner_id = ${userId}::uuid)
                THEN NULLIF(r.name, '') END AS name
      FROM users r WHERE r.id = ${reviewerId}::uuid
  `) as Array<{ name: string | null }>;
  return rows[0]?.name ?? null;
}
