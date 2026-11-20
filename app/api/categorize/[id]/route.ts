import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { QUEUE_SELECT, mapQueueRow, reviewerName } from "@/lib/categorize";
import { EXPENSE_TYPE_OPTIONS } from "@/lib/constants";
import { mapMerchant } from "@/lib/email/context";
import { ruleAfterAnswer } from "@/lib/email/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = Parameters<typeof mapQueueRow>[0] & { reviewed_by: string | null; email_event_id: string | null };

/** One item for /categorize/[id]: the row, its merchant rule, its amount history. */
export async function GET(_request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;
  const id = String(context.params.id ?? "").trim();

  try {
    const rows = (await sql(
      `${QUEUE_SELECT.replace("SELECT t.id,", "SELECT t.reviewed_by, t.email_event_id, t.id,")}
       WHERE t.user_id = $1 AND t.id = $2`,
      [userId, id],
    )) as Row[];
    const row = rows[0];
    if (!row) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });

    const [history, name, source, claim] = await Promise.all([
      sql`
        SELECT old_amount, new_amount, reason, changed_at
          FROM transaction_amount_changes
         WHERE user_id = ${userId} AND transaction_id = ${id}
         ORDER BY changed_at ASC
      ` as unknown as Promise<Array<{ old_amount: string; new_amount: string; reason: string; changed_at: string }>>,
      reviewerName(sql, userId, row.reviewed_by),
      row.email_event_id
        ? (sql`
            SELECT parser_id, decision->>'reason' AS reason
              FROM email_events WHERE user_id = ${userId} AND id = ${row.email_event_id}::uuid
          ` as unknown as Promise<Array<{ parser_id: string | null; reason: string | null }>>)
        : Promise.resolve([] as Array<{ parser_id: string | null; reason: string | null }>),
      sql`
        SELECT EXISTS (
                 SELECT 1 FROM reconciliation_claim_links c
                  WHERE c.user_id = ${userId} AND c.sheet_row_id = ${id}
               ) AS claimed
      ` as unknown as Promise<Array<{ claimed: boolean }>>,
    ]);

    return NextResponse.json({
      item: mapQueueRow(row),
      fromEmail: row.email_event_id !== null,
      // A Venmo payment to a person: the screen offers no pre-picked guess.
      person: source[0]?.parser_id === "venmo",
      // A transfer waiting on "which Venmo?" (decide.ts venmo_* reasons) vs a
      // card payment / bank transfer waiting on any other account.
      venmoLeg: (source[0]?.reason ?? "").startsWith("venmo_"),
      reviewedByName: name,
      // Matched to a statement line: the statement is the amount, so the
      // screen offers no "final amount" (POST refuses one too).
      claimed: claim[0]?.claimed === true,
      amountHistory: history.map((h) => ({
        oldAmount: Number(h.old_amount),
        newAmount: Number(h.new_amount),
        reason: h.reason,
        changedAt: h.changed_at,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load" },
      { status: 502 },
    );
  }
}

/**
 * Answer: { category, always?, addToShortlist?, description?, amount? } (plan §5.5).
 * `description`, when sent, replaces the row's description in the same
 * update — the screen lets you edit it before you pick.
 *
 * `amount` is the final amount typed on the screen — a card alert comes at the
 * swipe, before the tip. It replaces the row's amount in the same
 * transaction, with a history line, and the alert's own amount is kept in
 * original_amount (a second copy of that alert is matched on it). Refused for
 * a row already matched to a statement line: there, the statement is the
 * amount.
 *
 * A CONDITIONAL update — `… AND review_status = 'needs_review'` — so when both
 * people answer the same item, the second gets 409 with who already filed it
 * and as what, and the screen offers Change (which goes through the ordinary
 * PATCH /api/transactions/[id]).
 *
 * `always` sets the merchant to auto; `addToShortlist` switches it to a
 * shortlist. A guess never creates a rule — only these explicit toggles do.
 */
export async function POST(request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId, actorId } = ctx;
  const id = String(context.params.id ?? "").trim();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (!(EXPENSE_TYPE_OPTIONS as readonly string[]).includes(category)) {
    return NextResponse.json({ error: "Pick one of the categories" }, { status: 400 });
  }
  const isIncome = category === "Income";
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 500) : null;
  let amount: number | null = null;
  if (body.amount !== undefined && body.amount !== null) {
    const n = Number(body.amount);
    if (!Number.isFinite(n) || n <= 0 || n >= 1e9) {
      return NextResponse.json({ error: "The final amount must be a positive number" }, { status: 400 });
    }
    amount = Math.round(n * 100) / 100;
  }

  try {
    if (amount !== null) {
      const claimed = (await sql`
        SELECT EXISTS (
                 SELECT 1 FROM reconciliation_claim_links c
                  WHERE c.user_id = ${userId} AND c.sheet_row_id = ${id}
               ) AS claimed
      `) as Array<{ claimed: boolean }>;
      if (claimed[0]?.claimed) {
        return NextResponse.json(
          {
            error:
              "This purchase is already matched to your statement in Reconcile, so its amount comes from the statement. Pick a category without changing the amount.",
          },
          { status: 422 },
        );
      }
    }

    const results = await sql.transaction([
      // Lock the row so the history line and the update see the same state.
      sql`SELECT 1 FROM transactions WHERE user_id = ${userId} AND id = ${id} FOR UPDATE`,
      // History first, while `amount` still holds the alert's value.
      sql`
        INSERT INTO transaction_amount_changes
          (user_id, transaction_id, old_amount, new_amount, reason, changed_by)
        SELECT ${userId}::uuid, t.id, t.amount, ${amount}::numeric, 'manual', ${actorId}::uuid
          FROM transactions t
         WHERE t.user_id = ${userId} AND t.id = ${id}
           AND t.review_status = 'needs_review' AND t.kind <> 'transfer'
           AND ${amount}::numeric IS NOT NULL AND t.amount <> ${amount}::numeric
      `,
      sql`
        UPDATE transactions
           SET category = ${category},
               description = COALESCE(${description}::text, description),
               original_amount = CASE WHEN ${amount}::numeric IS NOT NULL AND source = 'email'
                                           AND amount <> ${amount}::numeric
                                      THEN COALESCE(original_amount, amount)
                                      ELSE original_amount END,
               amount = COALESCE(${amount}::numeric, amount),
               kind = ${isIncome ? "income" : "expense"},
               categorized_by = 'user',
               review_status = 'confirmed',
               reviewed_by = ${actorId}::uuid,
               reviewed_at = now(),
               updated_at = now()
         WHERE user_id = ${userId} AND id = ${id}
           AND review_status = 'needs_review' AND kind <> 'transfer'
        RETURNING merchant_id,
                  COALESCE((SELECT e.parser_id = 'venmo' FROM email_events e
                             WHERE e.user_id = transactions.user_id AND e.id = transactions.email_event_id), false) AS from_venmo
      `,
    ]);
    const updated = results[2] as Array<{ merchant_id: string | null; from_venmo: boolean }>;

    if (updated.length === 0) {
      const current = (await sql`
        SELECT category, reviewed_by, review_status, kind FROM transactions
         WHERE user_id = ${userId} AND id = ${id}
      `) as Array<{ category: string | null; reviewed_by: string | null; review_status: string; kind: string }>;
      if (!current[0]) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
      return NextResponse.json(
        {
          error: "Already filed",
          category: current[0].category,
          reviewedByName: await reviewerName(sql, userId, current[0].reviewed_by),
          reviewedByYou: current[0].reviewed_by === actorId,
        },
        { status: 409 },
      );
    }

    // Rule changes (never for an Income answer: a refund isn't a merchant habit).
    const merchantId = updated[0].merchant_id;
    let rule: ReturnType<typeof ruleAfterAnswer> = null;
    if (merchantId && !isIncome) {
      const merchants = (await sql`
        SELECT id, display_name, mode, category, shortlist, default_category
          FROM merchants WHERE user_id = ${userId} AND id = ${merchantId}::uuid
      `) as Array<Parameters<typeof mapMerchant>[0]>;
      if (merchants[0]) {
        rule = ruleAfterAnswer(
          mapMerchant(merchants[0]),
          { category, always: body.always === true, addToShortlist: body.addToShortlist === true },
          // A Venmo person's answer is never remembered as a default guess.
          { person: updated[0].from_venmo === true },
        );
        if (rule) {
          await sql`
            UPDATE merchants
               SET mode = ${rule.mode},
                   category = ${rule.category},
                   shortlist = ${rule.shortlist}::text[],
                   default_category = ${rule.defaultCategory}
             WHERE user_id = ${userId} AND id = ${merchantId}::uuid
          `;
        }
      }
    }
    return NextResponse.json({ ok: true, category, rule });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 502 },
    );
  }
}
