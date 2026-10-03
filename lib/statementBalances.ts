import type { Sql } from "@/lib/db";
import { listAccounts, toBankProfile } from "@/lib/accounts";
import { normalizedFlowDirection } from "@/lib/flowDirection";
import { mapBankRowsToTransactions } from "@/services/reconciliationService";

/**
 * Server half of statement-driven balances. Node-only: it parses stored CSV rows
 * with `reconciliationService`, which imports node:crypto.
 *
 * The client half is `computeAccountBalances`. This side only summarises what
 * the statements say. Anchors, opening balances and pending logged entries are
 * combined there, so one pure function stays the only place a balance is
 * computed.
 */

export type StatementSummary = {
  /** Net money movement per statement date, in dollars, sorted by date. */
  daily: Array<[date: string, net: number]>;
  /** Latest statement date. Logged entries after it count as pending. */
  lastDate: string;
  rowCount: number;
  /**
   * How the account's `outflow_is_positive` agrees with the logged entries its
   * bank lines are claimed to: an expense should be money out, income money in.
   * That flag is a detection guess, and a wrong guess inverts every statement
   * row, so this is the evidence the client uses to flag a reversed account.
   */
  directionCheck: { agree: number; disagree: number };
};

export type StatementBalanceInputs = {
  statements: Record<string, StatementSummary>;
  /** `"Expenses:<id>"` for every logged expense/income claimed to a bank line. */
  reconciledEntryKeys: string[];
  /** Transfer row id → accounts that have a bank leg claimed for it. */
  transferLegAccounts: Record<string, string[]>;
  /** `"Expenses:<id>"` / `"Transfers:<id>"` the user dismissed as never-on-a-statement. */
  dismissedEntryKeys: string[];
};

/**
 * Stored rows that are redundant copies of an already-resolved transaction.
 *
 * Overlapping legacy uploads left `X` resolved and `X-2` unresolved for what is
 * one bank line. For each identity group, drop one unresolved copy per resolved
 * sibling and keep any extras, because those are genuine duplicate purchases.
 * Shared by `/dedupe`, which deletes these rows, and by balances, which must not
 * count them twice before that has run.
 */
export function redundantDuplicateHashes(hashes: string[], resolved: Set<string>): Set<string> {
  const groups = new Map<string, string[]>();
  for (const hash of hashes) {
    const base = hash.replace(/-\d+$/, "");
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base)!.push(hash);
  }
  const redundant = new Set<string>();
  for (const members of groups.values()) {
    const resolvedCount = members.filter((h) => resolved.has(h)).length;
    const unresolved = members.filter((h) => !resolved.has(h));
    unresolved.slice(0, Math.min(resolvedCount, unresolved.length)).forEach((h) => redundant.add(h));
  }
  return redundant;
}

function toCents(n: number): number {
  return Math.round(n * 100);
}

export async function loadStatementBalanceInputs(
  sql: Sql,
  userId: string,
): Promise<StatementBalanceInputs> {
  // Every branch of every UNION carries its own user_id predicate.
  const [accounts, csvRows, resolvedRows, claimRows, transferLegRows, dismissalRows] =
    await Promise.all([
      listAccounts(sql, userId),
      // Order matches csv-rows: it determines the -N hash suffixes.
      sql`
        SELECT account_name, cells
        FROM reconciliation_csv_rows
        WHERE user_id = ${userId}
        ORDER BY created_at ASC, seq ASC
      ` as unknown as Promise<Array<{ account_name: string; cells: unknown }>>,
      sql`
        SELECT account_name AS a, bank_hash AS h FROM reconciliation_claim_links
          WHERE user_id = ${userId}
        UNION
        SELECT bank_account_name AS a, bank_hash AS h FROM reconciliation_transfer_claim_links
          WHERE user_id = ${userId}
        UNION
        SELECT account_name AS a, hash AS h FROM processed_transactions
          WHERE user_id = ${userId}
        UNION
        SELECT account_name AS a, hash AS h FROM reconciliation_statement_dismissals
          WHERE user_id = ${userId}
      ` as unknown as Promise<Array<{ a: string | null; h: string }>>,
      sql`
        SELECT c.bank_hash, c.account_name, c.sheet_name, c.sheet_row_id, t.kind
        FROM reconciliation_claim_links c
        LEFT JOIN transactions t
          ON t.user_id = c.user_id AND t.id = c.sheet_row_id
        WHERE c.user_id = ${userId}
      ` as unknown as Promise<
        Array<{
          bank_hash: string;
          account_name: string | null;
          sheet_name: string;
          sheet_row_id: string;
          kind: string | null;
        }>
      >,
      sql`
        SELECT transfer_sheet_row_id, bank_account_name
        FROM reconciliation_transfer_claim_links
        WHERE user_id = ${userId}
      ` as unknown as Promise<Array<{ transfer_sheet_row_id: string; bank_account_name: string | null }>>,
      sql`
        SELECT sheet_name, sheet_row_id
        FROM reconciliation_user_sheet_dismissals
        WHERE user_id = ${userId}
      ` as unknown as Promise<Array<{ sheet_name: string; sheet_row_id: string }>>,
    ]);

  const rowsByAccount = new Map<string, string[][]>();
  for (const row of csvRows) {
    const account = String(row.account_name ?? "").trim();
    if (!account || !Array.isArray(row.cells)) continue;
    const cells = row.cells.map((c: unknown) => String(c ?? ""));
    if (cells.length === 0) continue;
    if (!rowsByAccount.has(account)) rowsByAccount.set(account, []);
    rowsByAccount.get(account)!.push(cells);
  }

  const resolvedByAccount = new Map<string, Set<string>>();
  for (const row of resolvedRows) {
    const account = String(row.a ?? "").trim();
    if (!account) continue;
    if (!resolvedByAccount.has(account)) resolvedByAccount.set(account, new Set());
    resolvedByAccount.get(account)!.add(String(row.h));
  }

  // Logged kind per claimed bank hash, for the direction check.
  const kindsByHash = new Map<string, string[]>();
  for (const claim of claimRows) {
    if (claim.sheet_name !== "Expenses" || !claim.kind) continue;
    const list = kindsByHash.get(claim.bank_hash) ?? [];
    list.push(claim.kind);
    kindsByHash.set(claim.bank_hash, list);
  }

  const statements: Record<string, StatementSummary> = {};
  for (const account of accounts) {
    const rows = rowsByAccount.get(account.id);
    const profile = toBankProfile(account.csvProfile);
    if (!rows || !profile || !account.csvProfile) continue;

    const outflowIsPositive = account.csvProfile.outflowIsPositive;
    const txs = mapBankRowsToTransactions(account.id, rows, profile);
    const redundant = redundantDuplicateHashes(
      txs.map((tx) => tx.hash),
      resolvedByAccount.get(account.id) ?? new Set(),
    );

    const netCentsByDate = new Map<string, number>();
    let lastDate = "";
    let rowCount = 0;
    let agree = 0;
    let disagree = 0;
    for (const tx of txs) {
      if (redundant.has(tx.hash)) continue;
      const direction = normalizedFlowDirection(tx.amount, outflowIsPositive);
      const cents = direction * Math.abs(toCents(tx.amount));
      netCentsByDate.set(tx.date, (netCentsByDate.get(tx.date) ?? 0) + cents);
      if (tx.date > lastDate) lastDate = tx.date;
      rowCount += 1;

      for (const kind of kindsByHash.get(tx.hash) ?? []) {
        const expected = kind === "income" ? 1 : kind === "expense" ? -1 : 0;
        if (expected === 0) continue;
        if (expected === direction) agree += 1;
        else disagree += 1;
      }
    }
    if (rowCount === 0) continue;

    statements[account.id] = {
      daily: Array.from(netCentsByDate.entries())
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, cents]) => [date, cents / 100]),
      lastDate,
      rowCount,
      directionCheck: { agree, disagree },
    };
  }

  const reconciledEntryKeys = new Set<string>();
  const transferLegAccounts: Record<string, Set<string>> = {};
  const addLeg = (rowId: string, account: string | null) => {
    const key = String(account ?? "").trim();
    if (!rowId || !key) return;
    (transferLegAccounts[rowId] ??= new Set()).add(key);
  };
  for (const claim of claimRows) {
    if (claim.sheet_name === "Expenses") reconciledEntryKeys.add(`Expenses:${claim.sheet_row_id}`);
    // Legacy: transfer legs used to be written here as well. Still a real leg.
    else if (claim.sheet_name === "Transfers") addLeg(claim.sheet_row_id, claim.account_name);
  }
  for (const leg of transferLegRows) addLeg(leg.transfer_sheet_row_id, leg.bank_account_name);

  return {
    statements,
    reconciledEntryKeys: Array.from(reconciledEntryKeys),
    transferLegAccounts: Object.fromEntries(
      Object.entries(transferLegAccounts).map(([id, set]) => [id, Array.from(set)]),
    ),
    dismissedEntryKeys: dismissalRows.map((r) => `${r.sheet_name}:${r.sheet_row_id}`),
  };
}
