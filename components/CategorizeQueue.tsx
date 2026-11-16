"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRightLeft, CopyCheck, HelpCircle, Loader2, Tags } from "lucide-react";
import { useAccounts } from "@/contexts/AccountsContext";
import { useRefresh } from "@/contexts/RefreshContext";
import { fmtCents, fmtDollars } from "@/lib/emailSyncLabels";
import UnconfirmedChip from "@/components/UnconfirmedChip";

type Merchant = { id: string; displayName: string; mode: string; shortlist: string[]; defaultCategory: string | null };
type Item = {
  type: "transaction";
  id: string;
  kind: "expense" | "income" | "transfer";
  amount: number;
  originalAmount: number | null;
  date: string;
  description: string;
  account: string | null;
  transferFrom: string | null;
  transferTo: string | null;
  category: string | null;
  categorizedBy: string | null;
  reviewStatus: "needs_review" | "confirmed";
  isPending: boolean;
  autoMerged: boolean;
  duplicateOf: string | null;
  settled: boolean;
  merchant: Merchant | null;
};
type Ambiguous = {
  type: "ambiguous";
  id: string;
  receivedAt: string;
  amountCents: number | null;
  merchantName: string | null;
  accountName: string | null;
  candidates: Array<{ id: string; amount: number; date: string; description: string }>;
};
type Queue = { needsReview: Item[]; guessed: Item[]; duplicates: Item[]; ambiguous: Ambiguous[] };

type Filter = "all" | "guessed" | "duplicates";

/**
 * The To categorize list (plan §5.10). Self-contained on purpose (D5): it
 * fetches its own data and takes no props, so moving it into Reconcile later
 * is a re-mount, not a rewrite.
 */
export default function CategorizeQueue() {
  const { labelFor } = useAccounts();
  const { refreshKey, triggerRefresh } = useRefresh();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/categorize", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Failed to load (${res.status})`);
      setQueue(data as Queue);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const resolveAmbiguous = useCallback(
    async (eventId: string, body: Record<string, unknown>) => {
      setBusy(eventId);
      try {
        const res = await fetch(`/api/email-sync/events/${eventId}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? "Failed");
        triggerRefresh();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed");
      } finally {
        setBusy(null);
      }
    },
    [load, triggerRefresh],
  );

  const clearDuplicate = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        const res = await fetch(`/api/transactions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clearDuplicate: true }),
        });
        if (!res.ok) throw new Error("Failed to update");
        triggerRefresh();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed");
      } finally {
        setBusy(null);
      }
    },
    [load, triggerRefresh],
  );

  const deleteRow = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this entry? The other one stays.")) return;
      setBusy(id);
      try {
        const res = await fetch(`/api/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed to delete");
        triggerRefresh();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed");
      } finally {
        setBusy(null);
      }
    },
    [load, triggerRefresh],
  );

  const rows = useMemo(() => {
    if (!queue) return [];
    if (filter === "guessed") return queue.guessed;
    if (filter === "duplicates") return queue.duplicates;
    return queue.needsReview;
  }, [queue, filter]);

  if (!queue && !error) {
    return (
      <p className="text-sm text-gray-400 flex items-center gap-2 p-4">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </p>
    );
  }

  const chip = (value: Filter, label: string, count: number) => (
    <button
      type="button"
      onClick={() => setFilter(value)}
      className={`px-3 py-1 rounded-full text-xs border transition-colors ${
        filter === value
          ? "bg-[#50C878]/15 border-[#50C878]/50 text-[#50C878]"
          : "border-charcoal-dark text-gray-300 hover:text-white hover:bg-[#2f2f2f]"
      }`}
    >
      {label}
      <span className="ml-1 text-gray-500">{count}</span>
    </button>
  );

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-400">{error}</p>}
      {queue && (
        <div className="flex gap-2 flex-wrap">
          {chip("all", "All", queue.needsReview.length + queue.ambiguous.length)}
          {chip("guessed", "Guessed", queue.guessed.length)}
          {chip("duplicates", "Possible duplicates", queue.duplicates.length)}
        </div>
      )}

      {filter === "all" && queue?.ambiguous.map((a) => (
        <div key={a.id} className="rounded-xl border border-yellow-400/30 bg-[#252525] p-3 space-y-2">
          <div className="flex items-start gap-2">
            <HelpCircle className="w-4 h-4 text-yellow-300 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-white">
                Which purchase did this update? {fmtCents(a.amountCents)} · {a.merchantName ?? "Unknown"}
              </p>
              <p className="text-xs text-gray-500">{a.accountName}</p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            {a.candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={busy === a.id}
                onClick={() => void resolveAmbiguous(a.id, { transactionId: c.id })}
                className="text-left rounded-lg border border-charcoal-dark px-3 py-2 text-sm text-gray-200 hover:border-[#50C878]/60 hover:bg-[#2c2c2c] transition disabled:opacity-50"
              >
                {fmtDollars(c.amount)} · {c.date} · {c.description || "—"}
              </button>
            ))}
            <button
              type="button"
              disabled={busy === a.id}
              onClick={() => void resolveAmbiguous(a.id, { dismiss: true })}
              className="self-start text-xs text-gray-400 hover:text-white underline"
            >
              None of these — ignore the update
            </button>
          </div>
        </div>
      ))}

      {rows.length === 0 && (filter !== "all" || (queue?.ambiguous.length ?? 0) === 0) ? (
        <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-6 text-center text-sm text-gray-400">
          {filter === "duplicates"
            ? "No possible duplicates."
            : filter === "guessed"
              ? "No guessed categories in the last 60 days."
              : "Nothing to categorize. 🎉"}
        </div>
      ) : (
        <ul className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden divide-y divide-charcoal-dark">
          {rows.map((item, index) => {
            const isTransfer = item.kind === "transfer";
            const title = isTransfer
              ? `${labelFor(item.transferFrom) || "?"} → ${item.transferTo ? labelFor(item.transferTo) : "which account?"}`
              : item.merchant?.displayName || item.description || "Purchase";
            const body = (
              <div className={`flex items-center gap-3 px-3 py-2.5 ${index % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"}`}>
                <span className="shrink-0 text-gray-500">
                  {isTransfer ? (
                    <ArrowRightLeft className="w-4 h-4" />
                  ) : filter === "duplicates" ? (
                    <CopyCheck className="w-4 h-4" />
                  ) : (
                    <Tags className="w-4 h-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-white truncate">{title}</span>
                  <span className="block text-xs text-gray-500 truncate">
                    {item.date}
                    {!isTransfer && item.account ? ` · ${labelFor(item.account)}` : ""}
                    {item.isPending ? " · pending" : ""}
                    {item.autoMerged ? " · auto-merged" : ""}
                    {item.originalAmount !== null ? ` · updated from ${fmtDollars(item.originalAmount)}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm text-white tabular-nums">{fmtDollars(item.amount)}</span>
                  {!isTransfer && (
                    <span className="block">
                      {item.category ? (
                        <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                          {item.category}
                          {(item.reviewStatus === "needs_review" || item.categorizedBy === "guess") && (
                            <UnconfirmedChip transactionId={undefined} label="guess" />
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-500">no guess</span>
                      )}
                    </span>
                  )}
                </span>
              </div>
            );

            if (filter === "duplicates") {
              return (
                <li key={item.id}>
                  {body}
                  <div className="flex gap-3 px-3 pb-2.5 text-xs bg-inherit">
                    <span className="text-gray-500 flex-1">Logged by hand after a card alert of the same amount.</span>
                    <button
                      type="button"
                      disabled={busy === item.id}
                      onClick={() => void clearDuplicate(item.id)}
                      className="text-gray-300 hover:text-white underline disabled:opacity-50"
                    >
                      Keep both
                    </button>
                    <button
                      type="button"
                      disabled={busy === item.id}
                      onClick={() => void deleteRow(item.id)}
                      className="text-red-300 hover:text-red-200 underline disabled:opacity-50"
                    >
                      Delete this one
                    </button>
                  </div>
                </li>
              );
            }
            return (
              <li key={item.id}>
                <Link href={`/categorize/${encodeURIComponent(item.id)}`} className="block hover:brightness-110">
                  {body}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
