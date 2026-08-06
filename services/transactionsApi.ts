/**
 * Reads and writes the user's transactions via `/api/transactions` (Neon).
 *
 * This used to proxy Google Sheets. The row shapes below (`SheetRow`,
 * `TransferRow`) and the normalization helpers are deliberately unchanged:
 * `/api/transactions` returns rows already aliased to these camelCase field
 * names, so the alias table in `getRawValue` passes them through untouched and
 * every consumer of this module keeps working as-is.
 *
 * `rowId` / `transferRowId` are `transactions.id` — the same opaque UUIDs the
 * reconciliation tables reference in `sheet_row_id`.
 */

const TRANSACTIONS_API = "/api/transactions";

export type SheetRow = {
  timestamp?: string;
  /** Present when the sheet/API sends a separate date column. */
  date?: string;
  expenseType: string;
  amount: number;
  description: string;
  month: string;
  account?: string;
  rowId?: string;
};

function getRawValue(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key];
  }
  const normalized = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw)) {
    normalized.set(k.trim().toLowerCase(), v);
  }
  for (const key of keys) {
    const value = normalized.get(key.trim().toLowerCase());
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Normalize row keys from sheet (may be "Expense Type") to camelCase */
function normalizeRow(raw: Record<string, unknown>): SheetRow {
  const account = String(getRawValue(raw, ["Account", "account"]) ?? "");
  const rowIdRaw = getRawValue(raw, ["Row ID", "row id", "rowId", "row_id", "Row Id"]);
  const rowId = typeof rowIdRaw === "string" ? rowIdRaw.trim() : "";
  const dateRaw = getRawValue(raw, ["Date", "date"]);
  const dateStr = typeof dateRaw === "string" ? dateRaw.trim() : "";
  return {
    timestamp: (getRawValue(raw, ["Timestamp", "timestamp"]) as string | undefined),
    date: dateStr || undefined,
    expenseType: String(getRawValue(raw, ["Expense Type", "expenseType", "expense type"]) ?? ""),
    amount: Number(getRawValue(raw, ["Amount", "amount"]) ?? 0),
    description: String(getRawValue(raw, ["Description", "description"]) ?? ""),
    month: String(getRawValue(raw, ["Month", "month"]) ?? ""),
    account: account.trim() || undefined,
    rowId: rowId || undefined,
  };
}

function monthNameFromNumber(month: number): string {
  return [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ][month - 1] ?? "";
}

/** Exported for client-side filtering when using full-year cache. */
export function rowMatchesMonth(row: SheetRow, selectedMonth?: string): boolean {
  if (!selectedMonth || selectedMonth === "full") return true;
  const monthNum = Number(selectedMonth);
  if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) return true;

  // Prefer explicit Month column if present.
  const rawMonth = String(row.month ?? "").trim().toLowerCase();
  if (rawMonth) {
    const monthName = monthNameFromNumber(monthNum);
    const normalizedNumeric = String(parseInt(rawMonth, 10));
    if (
      rawMonth === String(monthNum) ||
      rawMonth === monthName ||
      rawMonth === `${monthName} 2026` ||
      normalizedNumeric === String(monthNum)
    ) {
      return true;
    }
  }

  // Fallback: infer from timestamp if month column is missing/inconsistent.
  if (row.timestamp) {
    const d = new Date(row.timestamp);
    if (!Number.isNaN(d.getTime()) && d.getMonth() + 1 === monthNum) {
      return true;
    }
  }

  return false;
}

/**
 * Fetch every expense/income row. The optional month filter is applied
 * client-side below, exactly as before.
 */
export async function getExpenses(month?: string): Promise<SheetRow[]> {
  const url = `${TRANSACTIONS_API}?kind=expenses`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch expenses: ${res.status}`);
  }
  const data = await res.json();
  const rows: Record<string, unknown>[] = Array.isArray(data)
    ? (data as Record<string, unknown>[])
    : ((data.rows ?? data.data ?? []) as Record<string, unknown>[]);
  const normalized: SheetRow[] = rows.map((r) => normalizeRow(r));
  return normalized.filter((row: SheetRow) => rowMatchesMonth(row, month));
}

/**
 * Create an expense/income row. `date` (YYYY-MM-DD) is optional; without it the
 * server stamps now.
 *
 * Returns the created row, including its `rowId` — additive, so existing
 * callers that ignore the result are unaffected.
 */
export async function submitExpense(payload: {
  expenseType: string;
  amount: number;
  description: string;
  date?: string;
  account?: string;
}): Promise<SheetRow> {
  const res = await fetch(TRANSACTIONS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to submit: ${res.status}`);
  }
  return normalizeRow((await res.json()) as Record<string, unknown>);
}

/**
 * Fields an existing transaction can be edited on. Every key is optional; only
 * the ones present are written, so a caller can send just the date.
 *
 * `expenseType` is ignored server-side for transfer rows (they have no
 * category), which is why `updateTransfer` doesn't accept it.
 */
export type TransactionPatch = {
  /** YYYY-MM-DD. Anchored at midday UTC server-side. */
  date?: string;
  amount?: number;
  expenseType?: string;
  description?: string;
};

async function patchTransaction(
  rowId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${TRANSACTIONS_API}/${encodeURIComponent(rowId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to update: ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Edit an expense/income row. Returns the row as stored, so callers can
 *  replace their cached copy rather than guessing the derived fields. */
export async function updateExpense(rowId: string, patch: TransactionPatch): Promise<SheetRow> {
  return normalizeRow(await patchTransaction(rowId, patch));
}

/** Edit a transfer row. Transfers have no category, so `expenseType` is not accepted. */
export async function updateTransfer(
  rowId: string,
  patch: Omit<TransactionPatch, "expenseType">,
): Promise<TransferRow> {
  return normalizeTransferRow(await patchTransaction(rowId, patch));
}

/**
 * Permanently delete a transaction.
 *
 * Reconciliation links are intentionally left behind server-side — see the
 * comment in `app/api/transactions/[id]/route.ts`.
 */
export async function deleteTransaction(rowId: string): Promise<void> {
  const res = await fetch(`${TRANSACTIONS_API}/${encodeURIComponent(rowId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to delete: ${res.status}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Transfers (separate "Transfers" sheet tab)                         */
/* ------------------------------------------------------------------ */

export type TransferRow = {
  timestamp?: string;
  date?: string;
  transferFrom: string;
  transferTo: string;
  amount: number;
  transferRowId?: string;
  /** Legacy rows only (old sheet had a description column instead of Transfer To). */
  description?: string;
  month: string;
};

function normalizeTransferRow(raw: Record<string, unknown>): TransferRow {
  const transferTo = String(getRawValue(raw, ["Transfer To", "transferTo", "transfer to"]) ?? "");
  const transferRowIdRaw = getRawValue(raw, [
    "Transfer Row ID",
    "transfer row id",
    "transferRowId",
    "transfer_row_id",
    "Transfer Row Id",
  ]);
  const transferRowId = typeof transferRowIdRaw === "string" ? transferRowIdRaw.trim() : "";
  const dateRaw = getRawValue(raw, ["Date", "date"]);
  const dateStr = typeof dateRaw === "string" ? dateRaw.trim() : "";
  return {
    timestamp: (getRawValue(raw, ["Timestamp", "timestamp"]) as string | undefined),
    date: dateStr || undefined,
    transferFrom: String(
      getRawValue(raw, ["Transfer from", "Transfer From", "transferFrom", "transfer from"]) ?? ""
    ),
    transferTo,
    amount: Number(getRawValue(raw, ["Transfer Amount", "transfer amount", "amount"]) ?? 0),
    transferRowId: transferRowId || undefined,
    description: (() => {
      const d = getRawValue(raw, [
        "Transfer Description",
        "Transfer Descriptior",
        "transfer description",
        "description",
      ]);
      const s = typeof d === "string" ? d.trim() : "";
      return s || undefined;
    })(),
    month: String(getRawValue(raw, ["Month", "month"]) ?? ""),
  };
}

/** Exported for client-side filtering when using full-year cache. */
export function transferMatchesMonth(row: TransferRow, selectedMonth?: string): boolean {
  if (!selectedMonth || selectedMonth === "full") return true;
  const monthNum = Number(selectedMonth);
  if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) return true;

  const rawMonth = String(row.month ?? "").trim().toLowerCase();
  if (rawMonth) {
    const monthName = monthNameFromNumber(monthNum);
    const normalizedNumeric = String(parseInt(rawMonth, 10));
    if (
      rawMonth === String(monthNum) ||
      rawMonth === monthName ||
      rawMonth === `${monthName} 2026` ||
      normalizedNumeric === String(monthNum)
    ) {
      return true;
    }
  }

  if (row.timestamp) {
    const d = new Date(row.timestamp);
    if (!Number.isNaN(d.getTime()) && d.getMonth() + 1 === monthNum) {
      return true;
    }
  }

  return false;
}

export async function getTransfers(month?: string): Promise<TransferRow[]> {
  const url = `${TRANSACTIONS_API}?kind=transfers`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch transfers: ${res.status}`);
  }
  const data = await res.json();
  const rows: Record<string, unknown>[] = Array.isArray(data)
    ? (data as Record<string, unknown>[])
    : ((data.rows ?? data.data ?? []) as Record<string, unknown>[]);
  const normalized = rows.map((r) => normalizeTransferRow(r));
  return normalized.filter((row) => transferMatchesMonth(row, month));
}

export async function submitTransfer(payload: {
  transferFrom: string;
  transferTo: string;
  amount: number;
  description?: string;
  date?: string;
}): Promise<TransferRow> {
  const res = await fetch(TRANSACTIONS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "transfer", ...payload }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to submit transfer: ${res.status}`);
  }
  return normalizeTransferRow((await res.json()) as Record<string, unknown>);
}
