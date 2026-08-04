import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { RECONCILIATION_RESET_CONFIRM } from "@/lib/reconciliationReset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wipes the calling user's reconciliation state.
 *
 * Every DELETE here MUST carry `WHERE user_id` — an unqualified DELETE would
 * wipe every user's data, not just the caller's.
 *
 * Deliberately NOT cleared, matching the pre-existing behavior the reset modal
 * describes: reconciliation_activity_log (the audit trail outlives the data it
 * describes), reconciliation_merchant_memory, and account_anchors.
 */
export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { confirm?: unknown };
  try {
    body = (await request.json()) as { confirm?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.confirm !== RECONCILIATION_RESET_CONFIRM) {
    return NextResponse.json(
      { error: `Send confirm: "${RECONCILIATION_RESET_CONFIRM}" to proceed.` },
      { status: 400 },
    );
  }

  try {
    await sql.transaction([
      sql`DELETE FROM reconciliation_claim_links WHERE user_id = ${userId}`,
      sql`DELETE FROM reconciliation_transfer_claim_links WHERE user_id = ${userId}`,
      sql`DELETE FROM reconciliation_statement_dismissals WHERE user_id = ${userId}`,
      sql`DELETE FROM reconciliation_uploaded_files WHERE user_id = ${userId}`,
      sql`DELETE FROM processed_transactions WHERE user_id = ${userId}`,
      sql`DELETE FROM reconciliation_user_sheet_dismissals WHERE user_id = ${userId}`,
      sql`DELETE FROM reconciliation_csv_rows WHERE user_id = ${userId}`,
      sql`DELETE FROM reconciliation_match_cache WHERE user_id = ${userId}`,
    ]);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Reconciliation reset error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reset reconciliation data" },
      { status: 502 },
    );
  }
}
