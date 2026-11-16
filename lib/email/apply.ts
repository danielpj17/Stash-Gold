import { createHash, randomUUID } from "crypto";
import type { Sql } from "@/lib/db";
import type { NewTransaction, Plan, RowUpdate } from "@/lib/email/decide";
import { MERCHANT_KEY_VERSION, displayNameFromRaw } from "@/lib/email/merchantKey";
import type { MerchantRule } from "@/lib/email/rules";
import { starterGuess } from "@/lib/email/rules";

/**
 * Turn a plan into ONE `sql.transaction([...])` (plan §5.2 "Atomic apply").
 *
 * The transaction write, the merchant/alias upsert, the amount-change row and
 * the event's final status commit together or not at all. Neon's HTTP
 * transactions are non-interactive, so every decision was made before this
 * point; the races that leaves (two writers between read and write) are closed
 * by the poller's LockService plus the unique indexes, which is why every
 * insert here tolerates a conflict.
 *
 * Every statement filters on the scope `userId` (invariant 1).
 *
 * Note: @neondatabase/serverless 0.10 does not compose query fragments, so
 * subqueries are written inline and switched with CASE on a bound boolean.
 */

export type ApplyInput = {
  userId: string;
  eventId: string;
  occurredAt: string;
  merchantKey: string;
  merchantRaw: string;
  merchant: MerchantRule | null;
  plan: Plan;
  parserId: string;
  parserVersion: number;
  parsed: unknown;
  /** Stored on the event alongside the plan. */
  decisionExtra?: Record<string, unknown>;
};

export function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** A stable id for a row that can't carry the event id (the Venmo receipt's transfer). */
export function derivedId(eventId: string, ref: string): string {
  const h = createHash("sha256").update(`${eventId}:${ref}`).digest("hex");
  // Shaped like a UUID (version nibble 5) so it looks like every other row id.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function needsMerchant(plan: Plan): boolean {
  if (plan.action === "create") return plan.transactions.some((t) => t.attachMerchant);
  if (plan.action === "link") return plan.update.attachMerchant === true;
  return false;
}

function insertTx(
  sql: Sql,
  userId: string,
  eventId: string,
  occurredAt: string,
  id: string,
  tx: NewTransaction,
  key: string,
) {
  const attachMerchant = tx.attachMerchant && key !== "";
  return sql`
    INSERT INTO transactions (
      id, user_id, entered_by, kind, occurred_at, amount, category, description,
      account, transfer_from, transfer_to, source, review_status, categorized_by,
      is_pending, merchant_id, email_event_id
    )
    VALUES (
      ${id}, ${userId}::uuid, NULL, ${tx.kind}, ${occurredAt}::timestamptz,
      ${dollars(tx.amountCents)}::numeric, ${tx.category}, ${tx.description.slice(0, 500)},
      ${tx.account}, ${tx.transferFrom}, ${tx.transferTo}, 'email', ${tx.reviewStatus},
      ${tx.categorizedBy},
      ${tx.isPending},
      CASE WHEN ${attachMerchant}::boolean THEN (
        SELECT merchant_id FROM merchant_aliases
         WHERE user_id = ${userId}::uuid AND normalized_key = ${key}
      ) END,
      ${tx.attachEvent ? eventId : null}::uuid
    )
    ON CONFLICT DO NOTHING
  `;
}

function updateTx(sql: Sql, userId: string, eventId: string, u: RowUpdate, key: string) {
  const attachMerchant = u.attachMerchant === true && key !== "";
  return sql`
    UPDATE transactions
       SET account = COALESCE(${u.account ?? null}, account),
           transfer_from = COALESCE(${u.transferFrom ?? null}, transfer_from),
           transfer_to = COALESCE(${u.transferTo ?? null}, transfer_to),
           is_pending = COALESCE(${u.isPending ?? null}::boolean, is_pending),
           review_status = COALESCE(${u.reviewStatus ?? null}, review_status),
           email_event_id = CASE WHEN ${u.attachEvent === true}::boolean
                                 THEN COALESCE(email_event_id, ${eventId}::uuid)
                                 ELSE email_event_id END,
           merchant_id = CASE WHEN ${attachMerchant}::boolean
                              THEN COALESCE((
                                SELECT merchant_id FROM merchant_aliases
                                 WHERE user_id = ${userId}::uuid AND normalized_key = ${key}
                              ), merchant_id)
                              ELSE merchant_id END,
           updated_at = now()
     WHERE user_id = ${userId} AND id = ${u.id}
  `;
}

export async function applyPlan(sql: Sql, input: ApplyInput): Promise<{ transactionId: string | null }> {
  const { userId, eventId, plan } = input;
  const key = input.merchantKey;
  const queries = [];

  // ---- merchant + alias -------------------------------------------------------
  if (needsMerchant(plan) && key) {
    if (input.merchant) {
      queries.push(sql`
        UPDATE merchants SET last_seen_at = now()
         WHERE user_id = ${userId} AND id = ${input.merchant.id}::uuid
      `);
      queries.push(sql`
        UPDATE merchant_aliases SET last_seen_at = now()
         WHERE user_id = ${userId} AND normalized_key = ${key}
      `);
    } else {
      const merchantId = randomUUID();
      queries.push(sql`
        INSERT INTO merchants (user_id, id, display_name, mode, default_category, last_seen_at)
        VALUES (${userId}::uuid, ${merchantId}::uuid, ${displayNameFromRaw(input.merchantRaw)},
                'ask_all', ${starterGuess(key)}, now())
      `);
      queries.push(sql`
        INSERT INTO merchant_aliases (user_id, normalized_key, key_version, merchant_id, example_raw, last_seen_at)
        VALUES (${userId}::uuid, ${key}, ${MERCHANT_KEY_VERSION}, ${merchantId}::uuid,
                ${input.merchantRaw.slice(0, 300)}, now())
        ON CONFLICT (user_id, normalized_key) DO UPDATE SET last_seen_at = now()
      `);
      // Lost a race with another writer for the same new merchant: its alias
      // won, so drop the merchant row nobody points at.
      queries.push(sql`
        DELETE FROM merchants m
         WHERE m.user_id = ${userId} AND m.id = ${merchantId}::uuid
           AND NOT EXISTS (
             SELECT 1 FROM merchant_aliases a WHERE a.user_id = m.user_id AND a.merchant_id = m.id
           )
      `);
    }
  }

  let explicitTxId: string | null = null;

  // ---- plan-specific writes -------------------------------------------------
  if (plan.action === "create") {
    for (const tx of plan.transactions) {
      const id = tx.ref === "primary" ? randomUUID() : derivedId(eventId, tx.ref);
      if (tx.ref === "primary") explicitTxId = id;
      queries.push(insertTx(sql, userId, eventId, input.occurredAt, id, tx, key));
    }
    for (const update of plan.updates) queries.push(updateTx(sql, userId, eventId, update, key));
  } else if (plan.action === "link") {
    explicitTxId = plan.transactionId;
    queries.push(updateTx(sql, userId, eventId, plan.update, key));
  } else if (plan.action === "followup") {
    explicitTxId = plan.transactionId;
    const newAmount = dollars(plan.newAmountCents);
    if (plan.newAmountCents !== plan.oldAmountCents) {
      // Logged first, while `amount` still holds the old value. The unique
      // index on (user_id, transaction_id, email_event_id) makes a retry a no-op.
      queries.push(sql`
        INSERT INTO transaction_amount_changes
          (user_id, transaction_id, old_amount, new_amount, reason, email_event_id)
        SELECT ${userId}::uuid, t.id, t.amount, ${newAmount}::numeric, ${plan.changeReason}, ${eventId}::uuid
          FROM transactions t
         WHERE t.user_id = ${userId} AND t.id = ${plan.transactionId}
           AND NOT EXISTS (
             SELECT 1 FROM reconciliation_claim_links c
              WHERE c.user_id = ${userId} AND c.sheet_name = 'Expenses' AND c.sheet_row_id = t.id
           )
        ON CONFLICT DO NOTHING
      `);
    }
    // C21: never change the amount of a row that's been claimed in
    // reconciliation — its claim link's amount_cents is fixed.
    queries.push(sql`
      UPDATE transactions t
         SET amount = ${newAmount}::numeric,
             original_amount = CASE WHEN t.amount <> ${newAmount}::numeric
                                    THEN COALESCE(t.original_amount, t.amount)
                                    ELSE t.original_amount END,
             is_pending = ${plan.isPending},
             auto_merged = t.auto_merged OR ${plan.autoMerged},
             updated_at = now()
       WHERE t.user_id = ${userId} AND t.id = ${plan.transactionId}
         AND NOT EXISTS (
           SELECT 1 FROM reconciliation_claim_links c
            WHERE c.user_id = ${userId} AND c.sheet_name = 'Expenses' AND c.sheet_row_id = t.id
         )
    `);
  } else if (plan.action === "duplicate" || plan.action === "followup_ignored") {
    explicitTxId = plan.transactionId;
  }

  // ---- the event's final status, in the same transaction -----------------------
  const decision = JSON.stringify({ ...plan, ...(input.decisionExtra ?? {}) });
  queries.push(sql`
    UPDATE email_events
       SET status = ${plan.status},
           status_reason = ${plan.reason},
           parser_id = ${input.parserId},
           parser_version = ${input.parserVersion},
           parsed = ${JSON.stringify(input.parsed)}::jsonb,
           decision = ${decision}::jsonb,
           error = NULL,
           processed_at = now(),
           transaction_id = COALESCE(
             (SELECT id FROM transactions WHERE user_id = ${userId} AND email_event_id = ${eventId}::uuid),
             ${explicitTxId}
           )
     WHERE user_id = ${userId} AND id = ${eventId}::uuid
  `);

  await sql.transaction(queries);

  const rows = (await sql`
    SELECT transaction_id FROM email_events WHERE user_id = ${userId} AND id = ${eventId}::uuid
  `) as Array<{ transaction_id: string | null }>;
  return { transactionId: rows[0]?.transaction_id ?? null };
}

/** Write a non-transaction outcome (unparsed, ignored, unknown_account, shadow…). */
export async function finishEvent(
  sql: Sql,
  userId: string,
  eventId: string,
  outcome: {
    status: string;
    reason?: string | null;
    parserId?: string | null;
    parserVersion?: number | null;
    parsed?: unknown;
    decision?: unknown;
    error?: string | null;
  },
): Promise<void> {
  await sql`
    UPDATE email_events
       SET status = ${outcome.status},
           status_reason = ${outcome.reason ?? null},
           parser_id = ${outcome.parserId ?? null},
           parser_version = ${outcome.parserVersion ?? null}::int,
           parsed = ${outcome.parsed === undefined ? null : JSON.stringify(outcome.parsed)}::jsonb,
           decision = ${outcome.decision === undefined ? null : JSON.stringify(outcome.decision)}::jsonb,
           error = ${outcome.error ?? null},
           processed_at = now()
     WHERE user_id = ${userId} AND id = ${eventId}::uuid
  `;
}
