import type { FinancialAccount } from "@/lib/accounts";
import type { SheetRow, TransferRow } from "@/services/transactionsApi";
import type { StatementBalanceInputs, StatementSummary } from "@/lib/statementBalances";

export type { StatementBalanceInputs, StatementSummary };

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

export async function getStatementBalanceInputs(): Promise<StatementBalanceInputs> {
  const res = await fetch("/api/reconciliation/statement-balances", { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch statement balances: ${res.status}`);
  }
  return (await res.json()) as StatementBalanceInputs;
}

/**
 * Whether an account's statement signs look inverted: the bank lines claimed to
 * logged expenses mostly read as money IN. `outflow_is_positive` is a detection
 * guess, and when it is wrong every statement row moves the balance the wrong
 * way. Needs a few claims of evidence before saying so.
 */
export function statementDirectionLooksReversed(summary: StatementSummary | undefined): boolean {
  if (!summary) return false;
  const { agree, disagree } = summary.directionCheck;
  return disagree >= 3 && disagree > agree * 2;
}

/** A logged entry's calendar date, preferring the local `date` the API emits. */
function entryDateKey(row: { date?: string; timestamp?: string }): string {
  return toDateKey(row.date) || toDateKey(row.timestamp);
}

/**
 * Compute a balance per account.
 *
 * **Two sources, chosen per account.**
 *
 * - An account with uploaded statements (`statements.statements[id]`) takes its
 *   balance from them: anchor or opening balance, plus every statement row after
 *   the anchor (matched, unmatched and dismissed alike, because the money really
 *   moved), plus logged entries dated after the latest statement row that no bank line
 *   has claimed yet. A dismissed bank row therefore still moves the balance, which is
 *   the point: "dismiss" is a budget/reconciliation decision, not a claim that the
 *   money didn't move.
 * - Every other account falls back to logged entries alone, as before.
 *
 * Logged entries dated on or before the latest statement row are presumed covered by
 * it: the statement is the truth for that period, and an unreconciled entry
 * there is either still waiting to be matched (counting it would double it) or
 * never happened at the bank.
 *
 * The budget never reads this: it is built from logged expenses only.
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
  statementInputs: StatementBalanceInputs | null = null,
): Record<string, number> {
  const anchorByAccount = buildAnchorMap(accountAnchors);
  const statements = statementInputs?.statements ?? {};
  const reconciled = new Set(statementInputs?.reconciledEntryKeys ?? []);
  const dismissed = new Set(statementInputs?.dismissedEntryKeys ?? []);
  const transferLegs = statementInputs?.transferLegAccounts ?? {};

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

  // Statement-driven accounts: the statement rows themselves, and the date past
  // which logged entries are still pending.
  const pendingAfter: Record<string, string> = {};
  for (const accountKey of Object.keys(balances)) {
    const summary = statements[accountKey];
    if (!summary || summary.rowCount === 0) continue;
    const anchorDate = anchorByAccount.get(accountKey)?.asOfDate ?? "";
    let net = 0;
    for (const [date, amount] of summary.daily) {
      if (!anchorDate || date > anchorDate) net += amount;
    }
    balances[accountKey] = Math.round((balances[accountKey] + net) * 100) / 100;
    pendingAfter[accountKey] = summary.lastDate > anchorDate ? summary.lastDate : anchorDate;
  }

  /** Should a logged entry dated `dateKey` move `accountKey`? */
  const appliesTo = (accountKey: string, dateKey: string, coveredByStatement: boolean): boolean => {
    if (!accountKey || balances[accountKey] === undefined) return false;
    const cutoff = pendingAfter[accountKey];
    if (cutoff === undefined) return shouldApplyByAnchor(accountKey, dateKey, anchorByAccount);
    if (coveredByStatement) return false;
    // Undated entries can't be placed after the statement, so they don't count.
    return dateKey !== "" && dateKey > cutoff;
  };

  for (const t of allTransfers) {
    const amt = Number(t.amount);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const rowId = String(t.transferRowId ?? "");
    const isDismissed = rowId !== "" && dismissed.has(`Transfers:${rowId}`);
    const legs = (rowId && transferLegs[rowId]) || [];
    const fromKey = String(t.transferFrom ?? "").trim();
    const toKey = String(t.transferTo ?? "").trim();

    // The old path keys anchors on the UTC timestamp; keep it byte-identical.
    const anchorDate = toDateKey(t.timestamp);
    const statementDate = entryDateKey(t);
    const dateFor = (key: string) => (pendingAfter[key] === undefined ? anchorDate : statementDate);

    if (appliesTo(fromKey, dateFor(fromKey), isDismissed || legs.includes(fromKey))) {
      balances[fromKey] -= amt;
    }
    if (appliesTo(toKey, dateFor(toKey), isDismissed || legs.includes(toKey))) {
      balances[toKey] += amt;
    }
  }

  for (const row of allRows) {
    const amount = Number(row.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const accountKey = String(row.account ?? "").trim();
    const rowKey = `Expenses:${String(row.rowId ?? "")}`;
    const covered = row.rowId ? reconciled.has(rowKey) || dismissed.has(rowKey) : false;
    const dateKey =
      pendingAfter[accountKey] === undefined ? toDateKey(row.timestamp) : entryDateKey(row);
    if (!appliesTo(accountKey, dateKey, covered)) continue;

    if (row.expenseType === "Income") {
      balances[accountKey] += amount;
    } else {
      balances[accountKey] -= amount;
    }
  }

  return balances;
}
