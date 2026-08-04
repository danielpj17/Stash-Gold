"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, Trash2, Archive, ArchiveRestore } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import GlassDropdown from "@/components/GlassDropdown";
import { useAccounts } from "@/contexts/AccountsContext";
import { ACCOUNT_KINDS, type AccountKind, type FinancialAccount } from "@/lib/accounts";

const KIND_LABELS: Record<AccountKind, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  cash: "Cash",
  brokerage: "Brokerage",
  other: "Other",
};

const KIND_OPTIONS = ACCOUNT_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }));

const fmtMoney = (n: number) =>
  "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function AccountSettingsPage() {
  const { accounts, loading, error, setAccounts, refresh } = useAccounts();

  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<AccountKind>("checking");
  const [newOpening, setNewOpening] = useState("0");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleCreate = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const name = newName.trim();
      if (!name) return;
      setCreating(true);
      setFormError("");
      try {
        const res = await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            kind: newKind,
            openingBalance: Number(newOpening) || 0,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? `Failed to add account (${res.status})`);
        if (Array.isArray(data.accounts)) setAccounts(data.accounts);
        setNewName("");
        setNewOpening("0");
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "Failed to add account");
      } finally {
        setCreating(false);
      }
    },
    [newName, newKind, newOpening, setAccounts],
  );

  const patchAccount = useCallback(
    async (account: FinancialAccount, patch: Record<string, unknown>) => {
      setBusyId(account.id);
      setFormError("");
      try {
        const res = await fetch(`/api/accounts/${account.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? `Failed to update (${res.status})`);
        if (Array.isArray(data.accounts)) setAccounts(data.accounts);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "Failed to update account");
        await refresh();
      } finally {
        setBusyId(null);
      }
    },
    [setAccounts, refresh],
  );

  const handleDelete = useCallback(
    async (account: FinancialAccount) => {
      setBusyId(account.id);
      setFormError("");
      try {
        // First attempt is unforced: the API refuses with 409 + a count when the
        // account still has reconciliation data, so a misclick can't wipe it.
        let res = await fetch(`/api/accounts/${account.id}`, { method: "DELETE" });
        let data = await res.json().catch(() => ({}));

        if (res.status === 409 && data?.requiresForce) {
          const ok = window.confirm(
            `"${account.name}" still has ${data.stateCount} reconciliation record(s).\n\n` +
              "Deleting it also deletes its statement rows, matches, claims, dismissals and " +
              "anchors. This cannot be undone.\n\nDelete anyway?",
          );
          if (!ok) return;
          res = await fetch(`/api/accounts/${account.id}?force=true`, { method: "DELETE" });
          data = await res.json().catch(() => ({}));
        }

        if (!res.ok) throw new Error(data?.error ?? `Failed to delete (${res.status})`);
        if (Array.isArray(data.accounts)) setAccounts(data.accounts);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "Failed to delete account");
      } finally {
        setBusyId(null);
      }
    },
    [setAccounts],
  );

  return (
    <DashboardLayout>
      <div className="max-w-3xl space-y-4">
        <div>
          <h1 className="text-white text-xl font-semibold">Accounts</h1>
          <p className="text-sm text-gray-400 mt-1">
            Add the accounts you want to track — name them whatever you like. Each one can have
            its own bank CSV format, set up the first time you upload a statement on the{" "}
            <Link href="/reconcile" className="text-[#50C878] hover:brightness-110">
              Reconcile
            </Link>{" "}
            page.
          </p>
        </div>

        <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-semibold">Add an account</h2>
          </div>
          <form onSubmit={handleCreate} className="p-4 grid gap-3 sm:grid-cols-[1fr_10rem_9rem_auto] sm:items-end">
            <div>
              <label htmlFor="acct-name" className="block text-xs text-gray-400 mb-1">
                Name
              </label>
              <input
                id="acct-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Everyday Checking"
                maxLength={60}
                className="w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus:border-[#50C878]"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Type</label>
              <GlassDropdown
                value={newKind}
                onChange={(v) => setNewKind(v as AccountKind)}
                options={KIND_OPTIONS}
                aria-label="Account type"
              />
            </div>
            <div>
              <label htmlFor="acct-opening" className="block text-xs text-gray-400 mb-1">
                Starting balance
              </label>
              <input
                id="acct-opening"
                type="number"
                step="0.01"
                value={newOpening}
                onChange={(e) => setNewOpening(e.target.value)}
                className="w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-2 text-white text-right focus:outline-none focus:border-[#50C878]"
              />
            </div>
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="flex items-center justify-center gap-2 rounded-md bg-[#50C878] px-4 py-2 font-semibold text-charcoal disabled:opacity-50 hover:brightness-110 transition h-[42px]"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add
            </button>
          </form>
          {formError && <p className="px-4 pb-4 text-sm text-red-400">{formError}</p>}
        </section>

        <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-semibold">Your accounts</h2>
          </div>

          {loading ? (
            <p className="p-4 text-sm text-gray-400">Loading…</p>
          ) : error ? (
            <p className="p-4 text-sm text-red-400">{error}</p>
          ) : accounts.length === 0 ? (
            <p className="p-4 text-sm text-gray-400">
              No accounts yet. Add your first one above.
            </p>
          ) : (
            <ul className="divide-y divide-charcoal-dark">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className={`p-4 flex flex-wrap items-center gap-3 ${account.isActive ? "" : "opacity-60"}`}
                >
                  <input
                    defaultValue={account.name}
                    maxLength={60}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next && next !== account.name) {
                        void patchAccount(account, { name: next });
                      } else {
                        e.target.value = account.name;
                      }
                    }}
                    aria-label={`Name for ${account.name}`}
                    className="flex-1 min-w-[10rem] rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-2 text-white focus:outline-none focus:border-[#50C878]"
                  />

                  <div className="w-[9rem]">
                    <GlassDropdown
                      value={account.kind}
                      onChange={(v) => void patchAccount(account, { kind: v })}
                      options={KIND_OPTIONS}
                      aria-label={`Type for ${account.name}`}
                    />
                  </div>

                  <input
                    type="number"
                    step="0.01"
                    defaultValue={account.openingBalance}
                    onBlur={(e) => {
                      const next = Number(e.target.value);
                      if (Number.isFinite(next) && next !== account.openingBalance) {
                        void patchAccount(account, { openingBalance: next });
                      }
                    }}
                    aria-label={`Starting balance for ${account.name}`}
                    title="Starting balance"
                    className="w-[8rem] rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-2 text-white text-right focus:outline-none focus:border-[#50C878]"
                  />

                  <span
                    className={`text-xs px-2 py-1 rounded ${
                      account.csvProfile
                        ? "bg-[#50C878]/15 text-[#50C878]"
                        : "bg-yellow-400/10 text-yellow-300/90"
                    }`}
                    title={
                      account.csvProfile
                        ? "A CSV column mapping is saved for this account."
                        : "You'll map this bank's CSV columns the first time you upload a statement."
                    }
                  >
                    {account.csvProfile ? "CSV format set" : "No CSV format yet"}
                  </span>

                  <div className="flex items-center gap-1 ml-auto">
                    <button
                      type="button"
                      disabled={busyId === account.id}
                      onClick={() => void patchAccount(account, { isActive: !account.isActive })}
                      title={account.isActive ? "Archive (hide from pickers)" : "Restore"}
                      aria-label={account.isActive ? "Archive account" : "Restore account"}
                      className="p-2 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition disabled:opacity-50"
                    >
                      {account.isActive ? (
                        <Archive className="w-4 h-4" />
                      ) : (
                        <ArchiveRestore className="w-4 h-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === account.id}
                      onClick={() => void handleDelete(account)}
                      title="Delete account"
                      aria-label={`Delete ${account.name}`}
                      className="p-2 rounded-md text-gray-400 hover:text-red-400 hover:bg-charcoal transition disabled:opacity-50"
                    >
                      {busyId === account.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <p className="px-4 py-3 border-t border-charcoal-dark text-xs text-gray-500">
            Renaming is always safe — reconciliation data is linked to the account itself, not its
            name. Archiving hides an account from pickers while keeping its history; deleting
            removes that history for good. Starting balance is what the account held before your
            first logged transaction; confirming a statement balance on the Reconcile page
            overrides it from that date onward. Totals shown:{" "}
            {fmtMoney(accounts.reduce((sum, a) => sum + Number(a.openingBalance || 0), 0))} across{" "}
            {accounts.length} account{accounts.length === 1 ? "" : "s"}.
          </p>
        </section>
      </div>
    </DashboardLayout>
  );
}
