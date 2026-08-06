import type { FinancialAccount } from "@/lib/accounts";
import type { SheetRow, TransferRow } from "@/services/transactionsApi";

export type AccountAnchor = {
  accountName: string;
  confirmedBalance: number;
  asOfDate: string;
};

/**
 * Labels that intentionally are NOT accounts: money entering or leaving the
 * tracked set. A transfer touching one of these only moves the account side.
 */
export const EXTERNAL_TRANSFER_SOURCES = ["Parents", "Cash", "Other"] as const;
export const EXTERNAL_TRANSFER_DESTINATIONS = ["Cash", "Misc.", "Other"] as const;

function toDateKey(value?: string): string {
  if (!value) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const d = String(parsed.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function shouldApplyByAnchor(
  accountKey: string,
  transactionDate: string,
  anchorByAccount: Map<string, AccountAnchor>,
): boolean {
  const anchor = anchorByAccount.get(accountKey);
  if (!anchor) return true;
  const txDate = toDateKey(transactionDate);
  const anchorDate = toDateKey(anchor.asOfDate);
  if (!anchorDate) return true;
  if (!txDate) return false;
  // Only include transactions strictly after the anchor date.
  return txDate > anchorDate;
}

function buildAnchorMap(anchors: AccountAnchor[]): Map<string, AccountAnchor> {
  const map = new Map<string, AccountAnchor>();
  for (const anchor of anchors) {
    if (!Number.isFinite(anchor.confirmedBalance)) continue;
    const key = String(anchor.accountName ?? "").trim();
    if (!key) continue;
    map.set(key, {
      accountName: key,
      confirmedBalance: Number(anchor.confirmedBalance),
      asOfDate: toDateKey(anchor.asOfDate),
    });
  }
  return map;
}

export async function getAccountAnchors(): Promise<AccountAnchor[]> {
  const res = await fetch("/api/reconciliation/anchors", { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch account anchors: ${res.status}`);
  }
  const data = (await res.json()) as { anchors?: Array<Partial<AccountAnchor>> };
  const anchors = Array.isArray(data.anchors) ? data.anchors : [];
  return anchors
    .map((row) => ({
      accountName: String(row.accountName ?? ""),
      confirmedBalance: Number(row.confirmedBalance ?? 0),
      asOfDate: String(row.asOfDate ?? ""),
    }))
    .filter((row) => row.accountName.trim() !== "" && Number.isFinite(row.confirmedBalance));
}

/**
 * Compute a balance per account from the user's own data.
 *
 * `accounts` is the source of truth for BOTH the opening balances and the set
 * of accounts that exist at all. That second role matters: transactions
 * referencing anything outside this set are skipped, which is how transfers to
 * "Cash"/"Parents" correctly move only one side.
 *
 * Transactions reference accounts by id (`SheetRow.account`,
 * `TransferRow.transferFrom` / `.transferTo`); anything unrecognised is treated
 * as an external label.
 */
export function computeAccountBalances(
  allRows: SheetRow[],
  allTransfers: TransferRow[],
  accountAnchors: AccountAnchor[] = [],
  accounts: FinancialAccount[] = [],
): Record<string, number> {
  const anchorByAccount = buildAnchorMap(accountAnchors);

  const balances: Record<string, number> = {};
  for (const account of accounts) {
    balances[account.id] = Number(account.openingBalance ?? 0);
  }
  // An anchor is a confirmed statement balance: it replaces the opening balance
  // and everything before its date.
  for (const [accountKey, anchor] of anchorByAccount.entries()) {
    if (balances[accountKey] === undefined) continue;
    balances[accountKey] = anchor.confirmedBalance;
  }

  for (const t of allTransfers) {
    const amt = Number(t.amount);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const txDate = toDateKey(t.timestamp);
    const fromKey = String(t.transferFrom ?? "").trim();
    const toKey = String(t.transferTo ?? "").trim();

    if (
      fromKey &&
      balances[fromKey] !== undefined &&
      shouldApplyByAnchor(fromKey, txDate, anchorByAccount)
    ) {
      balances[fromKey] -= amt;
    }
    if (
      toKey &&
      balances[toKey] !== undefined &&
      shouldApplyByAnchor(toKey, txDate, anchorByAccount)
    ) {
      balances[toKey] += amt;
    }
  }

  for (const row of allRows) {
    const amount = Number(row.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const accountKey = String(row.account ?? "").trim();
    if (!accountKey || balances[accountKey] === undefined) continue;
    if (!shouldApplyByAnchor(accountKey, toDateKey(row.timestamp), anchorByAccount)) continue;

    if (row.expenseType === "Income") {
      balances[accountKey] += amount;
    } else {
      balances[accountKey] -= amount;
    }
  }

  return balances;
}
