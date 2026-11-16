import { EMAIL_SYNC_CONFIG } from "@/lib/email/config";
import { isGasHold } from "@/lib/email/decide";
import { merchantKey } from "@/lib/email/merchantKey";

/**
 * Reconcile's "Pending card alert $14.82 · McDonald's — Correct to $17.50 &
 * link" (plan §5.8). Pure and browser-safe.
 *
 * Deliberately OUTSIDE findMatches: it only ever proposes, for bank lines
 * findMatches left with no candidate. It never auto-applies and is excluded
 * from bulk approve, so auto-match behaviour is byte-identical to before.
 *
 * A candidate is an unclaimed pending email row on the same account, within
 * ±csvSuggestWindowDays, where the bank amount is the logged amount ×1.00–1.35
 * (tip categories) or the logged amount is a gas hold. A matching merchant key
 * raises confidence but isn't required.
 */

export type SuggestRow = {
  rowId?: string;
  amount: number;
  expenseType: string;
  description: string;
  account?: string;
  date?: string;
  timestamp?: string;
  isPending?: boolean;
  source?: string;
};

export type PendingSuggestion = {
  rowId: string;
  loggedAmount: number;
  bankAmount: number;
  description: string;
  merchantMatches: boolean;
  dayGap: number;
};

function dayOf(value: string | undefined): number | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
  const t = iso ? Date.parse(`${iso}T00:00:00Z`) : Date.parse(value);
  return Number.isNaN(t) ? null : Math.floor(t / 86_400_000);
}

export function pendingAmountSuggestions(
  bank: { amount: number; date: string; accountName: string; description: string },
  rows: SuggestRow[],
  claimedRowIds: Set<string>,
  cfg = EMAIL_SYNC_CONFIG,
): PendingSuggestion[] {
  const bankCents = Math.round(Math.abs(bank.amount) * 100);
  const bankDay = dayOf(bank.date);
  if (bankCents <= 0 || bankDay === null) return [];
  const bankKey = merchantKey(bank.description);

  const out: PendingSuggestion[] = [];
  for (const row of rows) {
    const rowId = (row.rowId ?? "").trim();
    if (!rowId || claimedRowIds.has(rowId)) continue;
    if (row.isPending !== true || row.source !== "email") continue;
    if ((row.account ?? "") !== bank.accountName) continue;
    const rowDay = dayOf(row.date ?? row.timestamp);
    if (rowDay === null) continue;
    const dayGap = Math.abs(bankDay - rowDay);
    if (dayGap > cfg.csvSuggestWindowDays) continue;

    const loggedCents = Math.round(Math.abs(row.amount) * 100);
    if (loggedCents === bankCents) continue; // findMatches' exact branch covers equal amounts
    const tip =
      (cfg.tipCategories as readonly string[]).includes(row.expenseType) &&
      bankCents > loggedCents &&
      bankCents <= Math.round(loggedCents * (1 + cfg.csvSuggestMaxIncreasePct / 100));
    const hold = row.expenseType === cfg.gasCategory && isGasHold(loggedCents, cfg);
    if (!tip && !hold) continue;

    out.push({
      rowId,
      loggedAmount: loggedCents / 100,
      bankAmount: bankCents / 100,
      description: row.description,
      merchantMatches: bankKey !== "" && merchantKey(row.description) === bankKey,
      dayGap,
    });
  }
  return out.sort((a, b) => Number(b.merchantMatches) - Number(a.merchantMatches) || a.dayGap - b.dayGap);
}
