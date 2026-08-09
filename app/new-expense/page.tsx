"use client";

import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import GlassDropdown from "@/components/GlassDropdown";
import NumberField from "@/components/NumberField";
import ShortcutSetupCard from "@/components/ShortcutSetupCard";
import { useRefresh } from "@/contexts/RefreshContext";
import { submitExpense } from "@/services/transactionsApi";
import { EXPENSE_TYPE_OPTIONS } from "@/lib/constants";
import { Loader2, Settings } from "lucide-react";
import Link from "next/link";

// No account picker: the server routes an accountless expense to the user's
// default account (`insertTransaction` → `getDefaultAccountId`), which is the
// same place a Shortcut-logged expense lands. Change the default under
// Reconcile → Accounts.
export default function NewExpensePage() {
  const { triggerRefresh } = useRefresh();
  const [expenseType, setExpenseType] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

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
      {/*
        Centred rather than left-aligned. The form is deliberately narrow, so
        on a wide screen pinning it left left a large dead area to its right
        that read as "something failed to load". `mx-auto` centres it within
        the content region (already inset by the sidebar), which is why this
        looks balanced rather than pushed off-centre.
      */}
      <div className="space-y-6 max-w-2xl mx-auto">
        {/*
          The gear is this page's only route to Settings, and in the installed
          PWA it is the app's ONLY route there — the sidebar is hidden and the
          bottom nav is full. Keep it reachable here.
        */}
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-white flex-1">New Expense</h1>
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className="shrink-0 p-2 -m-2 rounded-lg text-gray-400 hover:text-[#50C878] hover:bg-[#2c2c2c] transition-colors"
          >
            <Settings className="w-5 h-5" />
          </Link>
        </div>

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
                size="md"
                aria-label="Expense type"
              />
            </div>

            <div>
              <label htmlFor="amount" className="block text-sm font-medium text-gray-300 mb-1">
                Amount
              </label>
              <NumberField
                id="amount"
                value={amount}
                onChange={setAmount}
                step={0.01}
                min={0}
                required
                prefix="$"
                placeholder="0.00"
                size="lg"
                aria-label="Amount"
              />
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
                    Saving…
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
    </DashboardLayout>
  );
}
