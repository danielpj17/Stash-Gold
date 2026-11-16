import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { loadMerchantByKey } from "@/lib/email/context";
import { merchantKey } from "@/lib/email/merchantKey";
import { decideCategory } from "@/lib/email/rules";
import { insertTransaction, parseTransactionInput, selectTransactionRow } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Matched your card alert — Keep both instead?" (plan §5.7).
 *
 * `[id]` is the EMAIL row that a manual entry was absorbed into. This puts it
 * back the way it was before the absorb — waiting in To categorize with its
 * merchant's provisional guess — and saves the manual entry as its own row.
 *
 * Body: the same fields the manual entry was posted with, plus
 * `previousDescription` from the absorb response.
 */
export async function POST(request: NextRequest, context: { params: { id: string } }) {
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
  const parsed = parseTransactionInput(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const rows = (await sql`
      SELECT t.id, t.kind, t.merchant_id, e.parsed->>'merchantRaw' AS merchant_raw, e.parser_id
        FROM transactions t
        LEFT JOIN email_events e ON e.user_id = t.user_id AND e.id = t.email_event_id
       WHERE t.user_id = ${userId} AND t.id = ${id} AND t.source = 'email' AND t.kind <> 'transfer'
    `) as Array<{ id: string; kind: string; merchant_id: string | null; merchant_raw: string | null; parser_id: string | null }>;
    const emailRow = rows[0];
    if (!emailRow) return NextResponse.json({ error: "Card-alert transaction not found" }, { status: 404 });

    const key = merchantKey(emailRow.merchant_raw ?? "");
    const merchant = await loadMerchantByKey(sql, userId, key);
    const guess = decideCategory(merchant, key, { person: emailRow.parser_id === "venmo" });
    const isIncome = emailRow.kind === "income";
    const previousDescription =
      typeof body.previousDescription === "string" ? body.previousDescription.slice(0, 500) : null;

    await sql`
      UPDATE transactions
         SET review_status = ${isIncome ? "confirmed" : guess.reviewStatus},
             category = ${isIncome ? "Income" : guess.category},
             categorized_by = ${isIncome ? "rule" : guess.categorizedBy},
             reviewed_by = NULL,
             reviewed_at = NULL,
             entered_by = NULL,
             description = COALESCE(${previousDescription}, description),
             updated_at = now()
       WHERE user_id = ${userId} AND id = ${id}
    `;

    const row = await insertTransaction(sql, userId, parsed, actorId, { source: "manual" });
    return NextResponse.json({
      emailRow: await selectTransactionRow(sql, userId, id, isIncome ? "income" : "expense"),
      row,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to keep both" },
      { status: 502 },
    );
  }
}
