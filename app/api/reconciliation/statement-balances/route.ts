import { NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { loadStatementBalanceInputs } from "@/lib/statementBalances";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * What each account's uploaded statements say, for `computeAccountBalances`.
 * An account with statements takes its balance from them; the budget never
 * reads this. See "Balances" in the root CLAUDE.md.
 */
export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    return NextResponse.json(await loadStatementBalanceInputs(sql, userId));
  } catch (err) {
    console.error("Statement balances GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load statement balances" },
      { status: 502 },
    );
  }
}
