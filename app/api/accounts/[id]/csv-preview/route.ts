import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { getAccount } from "@/lib/accounts";
import { detectCsvProfile } from "@/lib/csvProfileDetection";
import {
  mapBankRowToTransaction,
  type BankProfile,
} from "@/services/reconciliationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEW_ROW_LIMIT = 8;

function toNullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Backs the CSV mapping step.
 *
 * Given raw rows it returns (a) a suggested column mapping and (b) a live
 * preview of how the *real* parser reads those rows under a given mapping.
 * Running this server-side is not optional: reconciliationService imports
 * node:crypto, so the browser can't call it — and previewing with a
 * reimplementation would defeat the purpose.
 */
export async function POST(request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  const accountId = String(context.params.id ?? "").trim();

  let body: { rows?: unknown; profile?: Record<string, unknown> | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: "rows must be an array" }, { status: 400 });
  }
  const rows: string[][] = body.rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))));

  const account = await getAccount(sql, userId, accountId);
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const detected = detectCsvProfile(rows);

  // Preview under the caller's mapping if they supplied one (they're dragging
  // dropdowns), otherwise under the stored one, otherwise the detected guess.
  const source = body.profile ?? account.csvProfile ?? detected;
  const profile: BankProfile = {
    dateIndex: toNullableInt((source as Record<string, unknown>).dateIndex),
    amountIndex: toNullableInt((source as Record<string, unknown>).amountIndex),
    descriptionIndex: toNullableInt((source as Record<string, unknown>).descriptionIndex),
    debitIndex: toNullableInt((source as Record<string, unknown>).debitIndex),
    creditIndex: toNullableInt((source as Record<string, unknown>).creditIndex),
    deriveDateFromDescription:
      (source as Record<string, unknown>).deriveDateFromDescription === true,
  };

  const parsed: Array<{ date: string; amount: number; description: string }> = [];
  for (const row of rows) {
    if (parsed.length >= PREVIEW_ROW_LIMIT) break;
    const tx = mapBankRowToTransaction(accountId, row, profile);
    if (tx) parsed.push({ date: tx.date, amount: tx.amount, description: tx.description });
  }

  // How many rows the mapping actually reads — the honest signal for whether it
  // is right, more than any single preview line.
  let parseableCount = 0;
  for (const row of rows) {
    if (mapBankRowToTransaction(accountId, row, profile)) parseableCount += 1;
  }

  return NextResponse.json({
    detected,
    preview: parsed,
    parseableCount,
    totalRows: rows.length,
    sampleRows: rows.slice(0, PREVIEW_ROW_LIMIT),
    columnCount: rows.reduce((max, row) => Math.max(max, row.length), 0),
  });
}
