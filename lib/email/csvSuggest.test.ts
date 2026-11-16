import { describe, expect, it } from "vitest";
import { pendingAmountSuggestions, type SuggestRow } from "@/lib/email/csvSuggest";

const row = (over: Partial<SuggestRow> = {}): SuggestRow => ({
  rowId: "r1",
  amount: 14.82,
  expenseType: "Eating Out",
  description: "McDonald's",
  account: "card",
  date: "2026-11-10",
  isPending: true,
  source: "email",
  ...over,
});
const bank = { amount: -17.5, date: "2026-11-12", accountName: "card", description: "MCDONALD'S F1234" };

describe("pendingAmountSuggestions (plan §5.8)", () => {
  it("offers a tipped correction on the same account", () => {
    const [s] = pendingAmountSuggestions(bank, [row()], new Set());
    expect(s).toMatchObject({ rowId: "r1", loggedAmount: 14.82, bankAmount: 17.5, merchantMatches: true });
  });
  it("offers a gas hold correction", () => {
    const out = pendingAmountSuggestions(
      { ...bank, amount: -43.17, description: "MAVERIK #412" },
      [row({ amount: 1, expenseType: "Gas", description: "Maverik" })],
      new Set(),
    );
    expect(out).toHaveLength(1);
  });
  it("never suggests claimed, non-pending, manual, other-account or far-away rows", () => {
    expect(pendingAmountSuggestions(bank, [row()], new Set(["r1"]))).toHaveLength(0);
    expect(pendingAmountSuggestions(bank, [row({ isPending: false })], new Set())).toHaveLength(0);
    expect(pendingAmountSuggestions(bank, [row({ source: "manual" })], new Set())).toHaveLength(0);
    expect(pendingAmountSuggestions(bank, [row({ account: "other" })], new Set())).toHaveLength(0);
    expect(pendingAmountSuggestions(bank, [row({ date: "2026-11-01" })], new Set())).toHaveLength(0);
  });
  it("ignores increases over 35% and categories that don't tip", () => {
    expect(pendingAmountSuggestions({ ...bank, amount: -25 }, [row()], new Set())).toHaveLength(0);
    expect(pendingAmountSuggestions(bank, [row({ expenseType: "Groceries" })], new Set())).toHaveLength(0);
  });
});
