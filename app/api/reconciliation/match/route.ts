import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { getAccount, toBankProfile } from "@/lib/accounts";
import type { Sql } from "@/lib/db";
import {
  findMatches,
  mapBankRowsToTransactions,
  type MerchantMemoryEntry,
  type SheetExpenseLike,
  type SheetTransferLike,
} from "@/services/reconciliationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MatchRequestBody = {
  accountName?: unknown;
  rows?: unknown;
  sheetExpenses?: unknown;
  sheetTransfers?: unknown;
  processedHashes?: unknown;
};

type ClaimLinkRow = {
  bank_hash: string;
  sheet_name: string;
  sheet_row_id: string;
};

function readStringFieldCaseInsensitive(
  row: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") return value;
  }
  const normalized = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    normalized.set(k.trim().toLowerCase(), v);
  }
  for (const key of keys) {
    const value = normalized.get(key.trim().toLowerCase());
    if (typeof value === "string") return value;
  }
  return undefined;
}

function normalizeSheetExpenses(value: unknown): SheetExpenseLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => row as Record<string, unknown>)
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      amount: Number(row.amount ?? 0),
      timestamp: typeof row.timestamp === "string" ? row.timestamp : undefined,
      date: typeof row.date === "string" ? row.date : undefined,
      description: typeof row.description === "string" ? row.description : undefined,
      expenseType: typeof row.expenseType === "string" ? row.expenseType : undefined,
      account: typeof row.account === "string" ? row.account : undefined,
      rowId: readStringFieldCaseInsensitive(row, ["rowId", "Row ID", "row id", "row_id", "Row Id"]),
    }))
    .filter((row) => Number.isFinite(row.amount));
}

function normalizeCsvRows(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => Array.isArray(row))
    .map((row) =>
      (row as unknown[]).map((cell) => (cell === null || cell === undefined ? "" : String(cell))),
    );
}

function normalizeSheetTransfers(value: unknown): SheetTransferLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => row as Record<string, unknown>)
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      amount: Number(row.amount ?? 0),
      timestamp: typeof row.timestamp === "string" ? row.timestamp : undefined,
      date: typeof row.date === "string" ? row.date : undefined,
      transferFrom: typeof row.transferFrom === "string" ? row.transferFrom : undefined,
      transferTo: typeof row.transferTo === "string" ? row.transferTo : undefined,
      description: typeof row.description === "string" ? row.description : undefined,
      transferRowId: readStringFieldCaseInsensitive(row, [
        "transferRowId",
        "Transfer Row ID",
        "transfer row id",
        "transfer_row_id",
        "Transfer Row Id",
      ]),
    }))
    .filter((row) => Number.isFinite(row.amount));
}

async function getMerchantMemoryForAccount(
  sql: Sql,
  userId: string,
  bankAccountName: string,
): Promise<MerchantMemoryEntry[]> {
  if (!bankAccountName) return [];
  try {
    const rows = (await sql`
      SELECT fingerprint, bank_account_name, sheet_category, sheet_account, confirmed_count
      FROM reconciliation_merchant_memory
      WHERE user_id = ${userId}
        AND bank_account_name = ${bankAccountName}
        AND confirmed_count >= 2
    `) as Array<{
      fingerprint: string;
      bank_account_name: string;
      sheet_category: string | null;
      sheet_account: string | null;
      confirmed_count: number;
    }>;
    return rows.map((row) => ({
      fingerprint: row.fingerprint,
      bankAccountName: row.bank_account_name,
      confirmedCount: Number(row.confirmed_count ?? 0),
      sheetCategory: row.sheet_category,
      sheetAccount: row.sheet_account,
    }));
  } catch {
    // Memory table missing — proceed without memory-based matching.
    return [];
  }
}

async function getClaimedExpenseRowIds(sql: Sql, userId: string): Promise<Set<string>> {
  try {
    const rows = (await sql`
      SELECT sheet_row_id
      FROM reconciliation_claim_links
      WHERE user_id = ${userId} AND sheet_name = 'Expenses'
    `) as Array<{ sheet_row_id: string }>;
    return new Set(rows.map((row) => String(row.sheet_row_id)));
  } catch {
    // If claim table does not exist yet, continue without filtering.
    return new Set<string>();
  }
}

type TransferClaimRow = {
  transfer_sheet_row_id: string;
  bank_amount_cents: number;
  expected_legs: number;
};

async function getTransferClaimStatusByRowId(
  sql: Sql,
  userId: string,
): Promise<
  Record<
    string,
    {
      claimedCount: number;
      expectedLegs: number;
      isComplete: boolean;
      hasPositive: boolean;
      hasNegative: boolean;
    }
  >
> {
  try {
    const rows = (await sql`
      SELECT transfer_sheet_row_id, bank_amount_cents, expected_legs
      FROM reconciliation_transfer_claim_links
      WHERE user_id = ${userId}
    `) as TransferClaimRow[];

    const statusByRowId: Record<
      string,
      {
        claimedCount: number;
        expectedLegs: number;
        isComplete: boolean;
        hasPositive: boolean;
        hasNegative: boolean;
      }
    > = {};

    for (const row of rows) {
      const rowId = String(row.transfer_sheet_row_id ?? "").trim();
      if (!rowId) continue;
      const expectedLegs = Number(row.expected_legs ?? 2) === 1 ? 1 : 2;
      if (!statusByRowId[rowId]) {
        statusByRowId[rowId] = {
          claimedCount: 0,
          expectedLegs,
          isComplete: false,
          hasPositive: false,
          hasNegative: false,
        };
      }
      statusByRowId[rowId].claimedCount += 1;
      if (expectedLegs > statusByRowId[rowId].expectedLegs) {
        statusByRowId[rowId].expectedLegs = expectedLegs;
      }
      const amount = Number(row.bank_amount_cents ?? 0);
      if (amount > 0) statusByRowId[rowId].hasPositive = true;
      if (amount < 0) statusByRowId[rowId].hasNegative = true;
    }

    for (const rowId of Object.keys(statusByRowId)) {
      const entry = statusByRowId[rowId];
      entry.isComplete = entry.claimedCount >= entry.expectedLegs;
    }

    return statusByRowId;
  } catch {
    // If table does not exist yet, continue without transfer-claim filtering.
    return {};
  }
}

async function getClaimLinksByBankHashes(
  sql: Sql,
  userId: string,
  bankHashes: string[],
): Promise<Map<string, Array<{ sheetName: string; sheetRowId: string }>>> {
  if (bankHashes.length === 0) {
    return new Map<string, Array<{ sheetName: string; sheetRowId: string }>>();
  }

  try {
    const expenseRows = (await sql`
      SELECT bank_hash, sheet_name, sheet_row_id
      FROM reconciliation_claim_links
      WHERE user_id = ${userId} AND bank_hash = ANY(${bankHashes}::text[])
      ORDER BY created_at ASC
    `) as ClaimLinkRow[];
    const transferRows = (await sql`
      SELECT bank_hash, 'Transfers' AS sheet_name, transfer_sheet_row_id AS sheet_row_id
      FROM reconciliation_transfer_claim_links
      WHERE user_id = ${userId} AND bank_hash = ANY(${bankHashes}::text[])
      ORDER BY created_at ASC
    `) as ClaimLinkRow[];

    const linksByHash = new Map<string, Array<{ sheetName: string; sheetRowId: string }>>();
    const allRows = [...expenseRows, ...transferRows];
    for (const row of allRows) {
      const bankHash = String(row.bank_hash ?? "").trim();
      const sheetName = String(row.sheet_name ?? "").trim();
      const sheetRowId = String(row.sheet_row_id ?? "").trim();
      if (!bankHash || !sheetName || !sheetRowId) continue;
      if (!linksByHash.has(bankHash)) linksByHash.set(bankHash, []);
      linksByHash.get(bankHash)?.push({ sheetName, sheetRowId });
    }
    return linksByHash;
  } catch {
    // If claim tables do not exist yet, continue with normal matcher behavior.
    return new Map<string, Array<{ sheetName: string; sheetRowId: string }>>();
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: MatchRequestBody;
  try {
    body = (await request.json()) as MatchRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }

  const account = await getAccount(sql, userId, accountName);
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (!account.csvProfile) {
    return NextResponse.json(
      {
        error: "This account has no CSV format set up yet.",
        needsCsvProfile: true,
        accountName: account.name,
      },
      { status: 409 },
    );
  }
  const bankProfile = toBankProfile(account.csvProfile);

  const rows = normalizeCsvRows(body.rows);
  const sheetExpenses = normalizeSheetExpenses(body.sheetExpenses);
  const sheetTransfers = normalizeSheetTransfers(body.sheetTransfers);
  // Always an explicit list. findMatches must never fall back to reading every
  // processed hash in the database — that read is not user-scoped.
  const processedHashes = Array.isArray(body.processedHashes)
    ? body.processedHashes.map((h) => String(h))
    : [];

  const bankTransactions = mapBankRowsToTransactions(accountName, rows, bankProfile).map((tx) => ({
    ...tx,
    accountName,
  }));
  const bankHashes = Array.from(new Set(bankTransactions.map((tx) => tx.hash)));
  const claimLinksByHash = await getClaimLinksByBankHashes(sql, userId, bankHashes);

  const claimedExpenseRowIds = await getClaimedExpenseRowIds(sql, userId);
  const transferClaimStatusByRowId = await getTransferClaimStatusByRowId(sql, userId);
  const merchantMemory = await getMerchantMemoryForAccount(sql, userId, accountName);
  const unclaimedSheetExpenses = sheetExpenses.filter((row) => {
    const rowId = (row.rowId ?? "").trim();
    if (!rowId) return true;
    return !claimedExpenseRowIds.has(rowId);
  });
  const availableSheetTransfers = sheetTransfers.filter((row) => {
    const rowId = (row.transferRowId ?? "").trim();
    if (!rowId) return true;
    const claimStatus = transferClaimStatusByRowId[rowId];
    return !claimStatus?.isComplete;
  });

  const expenseByRowId = new Map(
    sheetExpenses
      .map((row) => {
        const rowId = String(row.rowId ?? "").trim();
        return rowId ? [rowId, row] : null;
      })
      .filter(
        (
          entry,
        ): entry is [string, SheetExpenseLike] => entry !== null,
      ),
  );
  const transferByRowId = new Map(
    sheetTransfers
      .map((row) => {
        const rowId = String(row.transferRowId ?? "").trim();
        return rowId ? [rowId, row] : null;
      })
      .filter(
        (
          entry,
        ): entry is [string, SheetTransferLike] => entry !== null,
      ),
  );

  const claimedMatches: Awaited<ReturnType<typeof findMatches>> = [];
  const unclaimedBankTransactions: typeof bankTransactions = [];
  for (const tx of bankTransactions) {
    const links = claimLinksByHash.get(tx.hash);
    if (!links || links.length === 0) {
      unclaimedBankTransactions.push(tx);
      continue;
    }

    const linkedExpense = links
      .filter((link) => link.sheetName === "Expenses")
      .map((link) => expenseByRowId.get(link.sheetRowId))
      .find((row): row is SheetExpenseLike => Boolean(row));
    if (linkedExpense) {
      claimedMatches.push({
        bankTransaction: tx,
        matchType: "exact_match" as const,
        reason: "Claim Link: restored from Neon claim link.",
        matchedSheetExpense: linkedExpense,
        matchedSheetIndex: undefined,
      });
      continue;
    }

    const linkedTransfer = links
      .filter((link) => link.sheetName === "Transfers")
      .map((link) => transferByRowId.get(link.sheetRowId))
      .find((row): row is SheetTransferLike => Boolean(row));
    if (linkedTransfer) {
      claimedMatches.push({
        bankTransaction: tx,
        matchType: "exact_match" as const,
        reason: "Claim Link: restored from Neon transfer claim.",
        matchedSheetTransfer: linkedTransfer,
        matchedSheetTransferIndex: undefined,
      });
      continue;
    }

    claimedMatches.push({
      bankTransaction: tx,
      matchType: "processed" as const,
      reason: "Claim Link exists in Neon, but linked sheet row was not found in current sheet payload.",
      matchedByNeonHash: true,
    });
  }

  // Credit cards and debit/credit-column CSVs parse outgoing charges as
  // POSITIVE amounts, inverting the checking convention. The flag comes from the
  // account's confirmed CSV profile and only affects how the unmatched bucket is
  // classified (income vs. needs-an-expense) — never the parsed sign, which
  // would change hashes.
  const outgoingIsPositive = account.csvProfile.outflowIsPositive === true;

  const matcherMatches = await findMatches(unclaimedBankTransactions, unclaimedSheetExpenses, {
    processedHashes,
    sheetTransfers: availableSheetTransfers,
    transferClaimStatusByRowId,
    merchantMemory,
    outgoingIsPositive,
  });
  const matches = [...claimedMatches, ...matcherMatches];
  return NextResponse.json({ bankTransactions, matches });
}
