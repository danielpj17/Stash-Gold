"use client";

import { useCallback, useRef, useState } from "react";
import { modalDragHandleProps } from "@/lib/modalBehavior";
import {
  Loader2,
  Plus,
  Trash2,
  Star,
  Archive,
  ArchiveRestore,
  GripVertical,
} from "lucide-react";
import GlassDropdown from "@/components/GlassDropdown";
import NumberField from "@/components/NumberField";
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

/**
 * Add, rename, archive and delete accounts without leaving Reconcile.
 *
 * Deleting is a soft delete server-side: past matches against the account stay
 * matched and correctly named. The copy below says so, because "delete" that
 * silently preserves data is otherwise surprising in the other direction.
 */
export default function ManageAccountsModal({ onClose }: { onClose: () => void }) {
  const { accounts, setAccounts, refresh } = useAccounts();

  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<AccountKind>("checking");
  const [newOpening, setNewOpening] = useState("0");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const apply = useCallback(
    (data: { accounts?: FinancialAccount[] }) => {
      if (Array.isArray(data.accounts)) setAccounts(data.accounts);
    },
    [setAccounts],
  );

  const handleCreate = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const name = newName.trim();
      if (!name) return;
      setCreating(true);
      setError("");
      try {
        const res = await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, kind: newKind, openingBalance: Number(newOpening) || 0 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? `Failed to add account (${res.status})`);
        apply(data);
        setNewName("");
        setNewOpening("0");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add account");
      } finally {
        setCreating(false);
      }
    },
    [newName, newKind, newOpening, apply],
  );

  const patch = useCallback(
    async (account: FinancialAccount, body: Record<string, unknown>) => {
      setBusyId(account.id);
      setError("");
      try {
        const res = await fetch(`/api/accounts/${account.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? `Failed to update (${res.status})`);
        apply(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update account");
        await refresh();
      } finally {
        setBusyId(null);
      }
    },
    [apply, refresh],
  );

  /**
   * Drag-to-reorder.
   *
   * Pointer events rather than HTML5 drag-and-drop, which fires no events on
   * touch — and this modal is reachable inside the installed PWA. The same
   * handlers cover mouse and finger; `touch-action: none` on the handle stops
   * the browser scrolling the page instead of starting a drag.
   *
   * `dragOrder` is a local override rendered in place of the context list while
   * a drag is in flight, so rows follow the finger without a round trip per
   * move. It clears once the server's order comes back.
   */
  const [dragOrder, setDragOrder] = useState<FinancialAccount[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLLIElement | null>());

  const rows = dragOrder ?? accounts;

  const commitOrder = useCallback(
    async (next: FinancialAccount[]) => {
      const previous = accounts;
      setAccounts(next); // optimistic: the list must not snap back mid-gesture
      setDragOrder(null);
      setReordering(true);
      setError("");
      try {
        const res = await fetch("/api/accounts", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: next.map((a) => a.id) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? `Failed to save order (${res.status})`);
        apply(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save the new order");
        setAccounts(previous);
        await refresh();
      } finally {
        setReordering(false);
      }
    },
    [accounts, apply, refresh, setAccounts],
  );

  /** Move one row to a new index, returning a new array. */
  const moveRow = useCallback((list: FinancialAccount[], from: number, to: number) => {
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  }, []);

  const handleDragMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragId) return;
      const list = dragOrder ?? accounts;
      const from = list.findIndex((a) => a.id === dragId);
      if (from < 0) return;

      // Move as the pointer crosses a neighbour's midpoint — measured from the
      // live DOM, so it stays correct however the rows have wrapped.
      let to = from;
      for (let i = 0; i < list.length; i += 1) {
        const el = rowRefs.current.get(list[i].id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const middle = rect.top + rect.height / 2;
        if (i < from && event.clientY < middle) {
          to = i;
          break;
        }
        if (i > from && event.clientY > middle) to = i;
      }
      if (to !== from) setDragOrder(moveRow(list, from, to));
    },
    [accounts, dragId, dragOrder, moveRow],
  );

  const handleDragEnd = useCallback(() => {
    if (!dragId) return;
    const next = dragOrder;
    setDragId(null);
    // Only write when the order actually changed — a click on the handle is a
    // zero-distance drag, and that should not cost a request.
    if (next && next.some((a, i) => a.id !== accounts[i]?.id)) {
      void commitOrder(next);
    } else {
      setDragOrder(null);
    }
  }, [accounts, commitOrder, dragId, dragOrder]);

  /** Keyboard equivalent: focus a handle, then Arrow Up/Down. */
  const nudge = useCallback(
    (account: FinancialAccount, delta: -1 | 1) => {
      const from = accounts.findIndex((a) => a.id === account.id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= accounts.length) return;
      void commitOrder(moveRow(accounts, from, to));
    },
    [accounts, commitOrder, moveRow],
  );

  const handleDelete = useCallback(
    async (account: FinancialAccount) => {
      const ok = window.confirm(
        `Delete "${account.name}"?\n\n` +
          "It disappears from your accounts and pickers. Statements you've already " +
          "reconciled against it stay matched — nothing is un-matched.\n\n" +
          "Its transactions stop counting toward any balance, but remain in your " +
          "expense history and budget totals.",
      );
      if (!ok) return;

      setBusyId(account.id);
      setError("");
      try {
        const res = await fetch(`/api/accounts/${account.id}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? `Failed to delete (${res.status})`);
        apply(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete account");
      } finally {
        setBusyId(null);
      }
    },
    [apply],
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/60 p-4 flex items-start justify-center overflow-y-auto">
      <div className="w-full max-w-2xl my-8 rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
        <div {...modalDragHandleProps()} className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-2">
          <div>
            <h3 className="text-white font-semibold">Accounts</h3>
            <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1.5">
              Add or remove the accounts you reconcile against. Drag to reorder.
              {reordering && <Loader2 className="w-3 h-3 animate-spin" aria-label="Saving order" />}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-1 rounded-md text-gray-300 hover:text-white hover:bg-[#2f2f2f]"
          >
            Close
          </button>
        </div>

        <form
          onSubmit={handleCreate}
          className="p-4 border-b border-charcoal-dark grid gap-3 sm:grid-cols-[1fr_9rem_8rem_auto] sm:items-end"
        >
          <div>
            <label htmlFor="ma-name" className="block text-xs text-gray-400 mb-1">
              Name
            </label>
            <input
              id="ma-name"
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
            <label htmlFor="ma-open" className="block text-xs text-gray-400 mb-1">
              Starting balance
            </label>
            <NumberField
              id="ma-open"
              value={newOpening}
              onChange={setNewOpening}
              step={0.01}
              size="lg"
              inputClassName="text-right"
              aria-label="Starting balance"
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

        {error && <p className="px-4 pt-3 text-sm text-red-400">{error}</p>}

        {accounts.length === 0 ? (
          <p className="p-4 text-sm text-gray-400">No accounts yet. Add your first one above.</p>
        ) : (
          <ul className="divide-y divide-charcoal-dark">
            {rows.map((account) => (
              <li
                key={account.id}
                ref={(el) => {
                  rowRefs.current.set(account.id, el);
                }}
                className={`p-3 flex items-center gap-2 flex-wrap transition-colors ${
                  account.isActive ? "" : "opacity-60"
                } ${dragId === account.id ? "bg-[#333] ring-1 ring-inset ring-[#50C878]/40" : ""}`}
              >
                <button
                  type="button"
                  onPointerDown={(e) => {
                    // Capture so the drag survives the pointer leaving the row.
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDragOrder(accounts);
                    setDragId(account.id);
                  }}
                  onPointerMove={handleDragMove}
                  onPointerUp={handleDragEnd}
                  onPointerCancel={handleDragEnd}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                    e.preventDefault();
                    nudge(account, e.key === "ArrowUp" ? -1 : 1);
                  }}
                  // Without this the browser scrolls the page instead of
                  // reporting the pointer moves this drag is built on.
                  style={{ touchAction: "none" }}
                  title="Drag to reorder — or focus and use the arrow keys"
                  aria-label={`Reorder ${account.name}`}
                  className="shrink-0 p-1 -ml-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-charcoal cursor-grab active:cursor-grabbing touch-none focus:outline-none focus:text-[#50C878]"
                >
                  <GripVertical className="w-4 h-4" />
                </button>

                <input
                  defaultValue={account.name}
                  maxLength={60}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next && next !== account.name) void patch(account, { name: next });
                    else e.target.value = account.name;
                  }}
                  aria-label={`Name for ${account.name}`}
                  className="flex-1 min-w-[9rem] rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-1.5 text-white focus:outline-none focus:border-[#50C878]"
                />

                <div className="w-[8rem] shrink-0">
                  <GlassDropdown
                    value={account.kind}
                    onChange={(v) => void patch(account, { kind: v })}
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
                      void patch(account, { openingBalance: next });
                    }
                  }}
                  aria-label={`Starting balance for ${account.name}`}
                  title="Starting balance"
                  // Uncontrolled (commits on blur), so it keeps the plain input;
                  // the class only drops the stock spinners for consistency.
                  className="stash-number-input w-[7rem] shrink-0 rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-1.5 text-white text-right focus:outline-none focus:border-[#50C878]"
                />

                <span
                  className={`text-xs px-2 py-1 rounded shrink-0 ${
                    account.csvProfile
                      ? "bg-[#50C878]/15 text-[#50C878]"
                      : "bg-yellow-400/10 text-yellow-300/90"
                  }`}
                >
                  {account.csvProfile ? "CSV set" : "no CSV yet"}
                </span>

                <div className="flex items-center gap-1 ml-auto shrink-0">
                  <button
                    type="button"
                    disabled={busyId === account.id || account.isDefault}
                    onClick={() => void patch(account, { isDefault: true })}
                    title={
                      account.isDefault
                        ? "Default account — expenses with no account chosen land here"
                        : "Make this the default account"
                    }
                    aria-label={`Make ${account.name} the default account`}
                    className={`p-2 rounded-md transition disabled:cursor-default ${
                      account.isDefault
                        ? "text-[#50C878]"
                        : "text-gray-500 hover:text-[#50C878] hover:bg-charcoal"
                    }`}
                  >
                    <Star className={`w-4 h-4 ${account.isDefault ? "fill-current" : ""}`} />
                  </button>
                  <button
                    type="button"
                    disabled={busyId === account.id}
                    onClick={() => void patch(account, { isActive: !account.isActive })}
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
          The <Star className="w-3 h-3 inline -mt-0.5 fill-current text-[#50C878]" /> account is
          where expenses land when no account is chosen — including everything logged from the iOS
          Shortcut. Renaming is always safe. Deleting keeps past matches intact; archiving just
          hides an account from pickers. Starting balance is what the account held before your
          first logged transaction — confirming a statement balance overrides it from that date
          onward. The order you set here is the order accounts appear everywhere else, including
          the transfer pickers and the iOS Shortcut.
        </p>
      </div>
    </div>
  );
}
