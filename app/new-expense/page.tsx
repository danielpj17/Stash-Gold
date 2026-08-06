"use client";

import { useEffect, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import GlassDropdown from "@/components/GlassDropdown";
import ManageAccountsModal from "@/components/ManageAccountsModal";
import ShortcutSetupCard from "@/components/ShortcutSetupCard";
import { useRefresh } from "@/contexts/RefreshContext";
import { useAccounts } from "@/contexts/AccountsContext";
import { submitExpense } from "@/services/transactionsApi";
import { EXPENSE_TYPE_OPTIONS } from "@/lib/constants";
import { Loader2 } from "lucide-react";
import Link from "next/link";

export default function NewExpensePage() {
  const { triggerRefresh } = useRefresh();
  const { activeAccounts, defaultAccount, loading: accountsLoading } = useAccounts();
  const [manageAccountsOpen, setManageAccountsOpen] = useState(false);
  const [expenseType, setExpenseType] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  // Preselect the user's default account so the common case is one tap fewer,
  // and so the form agrees with where a Shortcut-logged expense would land.
  useEffect(() => {
    if (!account && defaultAccount) setAccount(defaultAccount.id);
  }, [account, defaultAccount]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const num = parseFloat(amount);
    if (!expenseType || Number.isNaN(num) || num <= 0) {
      setStatus("error");
      setErrorMessage("Please select a type and enter a valid amount.");
      return;
    }
    setStatus("submitting");
    setErrorMessage("");
    try {
      await submitExpense({
        expenseType,
        amount: num,
        description: description.trim(),
        account: account || undefined,
      });
      triggerRefresh();
      setStatus("success");
      setAmount("");
      setDescription("");
      setExpenseType("");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to submit.");
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-2xl">
        <h1 className="text-xl font-semibold text-white">New Expense</h1>

        <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-medium">Add transaction</h2>
          </div>
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div>
              <label htmlFor="expenseType" className="block text-sm font-medium text-gray-300 mb-1">
                Expense Type
              </label>
              <GlassDropdown
                id="expenseType"
                value={expenseType}
                onChange={setExpenseType}
                options={EXPENSE_TYPE_OPTIONS.map((opt) => ({ value: opt, label: opt }))}
                placeholder="Select type"
                className="w-full"
                aria-label="Expense type"
              />
            </div>

            <div>
              <label htmlFor="amount" className="block text-sm font-medium text-gray-300 mb-1">
                Amount
              </label>
              <input
                id="amount"
                type="number"
                step="0.01"
                min="0"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none"
              />
            </div>

            <div>
              <label htmlFor="account" className="block text-sm font-medium text-gray-300 mb-1">
                Account
              </label>
              {accountsLoading ? (
                <p className="text-sm text-gray-500 py-2">Loading accountsâ€¦</p>
              ) : activeAccounts.length === 0 ? (
                <p className="text-sm text-gray-400 py-2">
                  No accounts yet â€”{" "}
                  <button
                    type="button"
                    onClick={() => setManageAccountsOpen(true)}
                    className="text-accent hover:brightness-110 underline"
                  >
                    add one
                  </button>{" "}
                  so this shows up in your balances.
                </p>
              ) : (
                <GlassDropdown
                  id="account"
                  value={account}
                  onChange={setAccount}
                  options={activeAccounts.map((a) => ({ value: a.id, label: a.name }))}
                  placeholder="Select account"
                  className="w-full"
                  aria-label="Account"
                />
              )}
            </div>

            <div>
              <label htmlFor="description" className="block text-sm font-medium text-gray-300 mb-1">
                Description
              </label>
              <input
                id="description"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional notes"
                className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none"
              />
            </div>

            {status === "error" && (
              <p className="text-sm text-red-400">{errorMessage}</p>
            )}
            {status === "success" && (
              <p className="text-sm text-accent">Saved. Dashboard will reflect the new transaction.</p>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={status === "submitting"}
                className="px-4 py-2 rounded-lg bg-accent text-white font-medium hover:bg-accent-dark disabled:opacity-50 flex items-center gap-2"
              >
                {status === "submitting" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Savingâ€¦
                  </>
                ) : (
                  "Save"
                )}
              </button>
              <Link
                href="/"
                className="px-4 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-300 hover:text-white hover:border-accent/50 transition-colors"
              >
                View Budget
              </Link>
            </div>
          </form>
        </div>

        <ShortcutSetupCard />
      </div>

      {manageAccountsOpen && (
        <ManageAccountsModal onClose={() => setManageAccountsOpen(false)} />
      )}
    </DashboardLayout>
  );
}
