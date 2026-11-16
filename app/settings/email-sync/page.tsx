"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { useAccounts } from "@/contexts/AccountsContext";
import { useRefresh } from "@/contexts/RefreshContext";
import { fmtCents, fmtDollars, fmtWhen, reasonLabel, statusLabel } from "@/lib/emailSyncLabels";

type EventRow = {
  id: string;
  gmailMessageId: string;
  from: string;
  forwardedFor: string | null;
  subject: string | null;
  receivedAt: string;
  status: string;
  reason: string | null;
  parserId: string | null;
  error: string | null;
  transactionId: string | null;
  alertKind: string | null;
  amountCents: number | null;
  merchantRaw: string | null;
  last4: string | null;
  accountName: string | null;
  wouldBe: string | null;
};
type UnknownGroup = {
  parserId: string | null;
  parserLabel: string | null;
  last4: string | null;
  forwardedFrom: string | null;
  reason: string | null;
  count: number;
  latest: string;
};
type ShadowRow = {
  id: string;
  localDate: string;
  wouldBe: string | null;
  action: string | null;
  reason: string | null;
  alertKind: string | null;
  amountCents: number | null;
  merchantName: string | null;
  accountName: string | null;
  category: string | null;
  reviewStatus: string | null;
};
type ManualRow = { id: string; amount: number; category: string | null; description: string; localDate: string; source: string };

type Tab = "attention" | "shadow" | "all";

/**
 * Email activity (plan §5.10). Metadata only — bodies never leave the server.
 */
export default function EmailSyncActivityPage() {
  const { activeAccounts } = useAccounts();
  const { triggerRefresh } = useRefresh();
  const [tab, setTab] = useState<Tab>("attention");
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [attention, setAttention] = useState<EventRow[] | null>(null);
  const [unknown, setUnknown] = useState<UnknownGroup[]>([]);
  const [shadow, setShadow] = useState<{ shadow: ShadowRow[]; manual: ManualRow[] } | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [assignTo, setAssignTo] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError("");
    try {
      const [a, u, e, s] = await Promise.all([
        fetch("/api/email-sync/events?status=unparsed,unknown_account,unauthenticated&limit=100", { cache: "no-store" }),
        fetch("/api/email-sync/unknown-accounts", { cache: "no-store" }),
        fetch(`/api/email-sync/events?limit=100${statusFilter ? `&status=${statusFilter}` : ""}`, { cache: "no-store" }),
        fetch("/api/email-sync/shadow?days=14", { cache: "no-store" }),
      ]);
      if (!a.ok || !e.ok) throw new Error("Failed to load email activity");
      setAttention(((await a.json()) as { events: EventRow[] }).events);
      setEvents(((await e.json()) as { events: EventRow[] }).events);
      if (u.ok) setUnknown(((await u.json()) as { groups: UnknownGroup[] }).groups);
      if (s.ok) setShadow((await s.json()) as { shadow: ShadowRow[]; manual: ManualRow[] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const reread = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/email-sync/reread", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Re-read failed");
      const outcomes = Object.entries((data.outcomes ?? {}) as Record<string, number>)
        .map(([k, n]) => `${n} ${statusLabel(k).toLowerCase()}`)
        .join(", ");
      setMessage(data.processed ? `Re-read ${data.processed}: ${outcomes}.` : "Nothing to re-read.");
      triggerRefresh();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-read failed");
    } finally {
      setBusy(false);
    }
  }, [load, triggerRefresh]);

  const assign = useCallback(
    async (group: UnknownGroup) => {
      const key = `${group.parserId}|${group.last4}|${group.forwardedFrom}`;
      const accountId = assignTo[key];
      if (!accountId) return;
      setBusy(true);
      setMessage("");
      try {
        const res = await fetch("/api/email-sync/unknown-accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parserId: group.parserId,
            last4: group.last4,
            forwardedFrom: group.forwardedFrom,
            accountId,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? "Failed to assign");
        setMessage(`Assigned and re-read ${data.processed} email(s).`);
        triggerRefresh();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to assign");
      } finally {
        setBusy(false);
      }
    },
    [assignTo, load, triggerRefresh],
  );

  /** Shadow decisions and hand-logged entries, side by side per day. */
  const shadowDays = useMemo(() => {
    if (!shadow) return [];
    const days = new Map<string, { shadow: ShadowRow[]; manual: ManualRow[] }>();
    const day = (d: string) => {
      if (!days.has(d)) days.set(d, { shadow: [], manual: [] });
      return days.get(d)!;
    };
    shadow.shadow.forEach((r) => day(r.localDate ?? "?").shadow.push(r));
    shadow.manual.forEach((r) => day(r.localDate).manual.push(r));
    return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [shadow]);

  const tabButton = (value: Tab, label: string, count?: number) => (
    <button
      type="button"
      onClick={() => setTab(value)}
      className={`px-3 py-1.5 rounded-lg text-sm transition ${
        tab === value ? "bg-[#50C878]/15 text-[#50C878]" : "text-gray-300 hover:text-white hover:bg-[#2f2f2f]"
      }`}
    >
      {label}
      {count ? <span className="ml-1 text-xs text-gray-500">{count}</span> : null}
    </button>
  );

  const eventLine = (e: EventRow) => (
    <li key={e.id} className="px-3 py-2 text-sm">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span
          className={`text-xs px-1.5 py-px rounded ${
            ["unparsed", "unknown_account", "unauthenticated", "ambiguous"].includes(e.status)
              ? "bg-yellow-400/10 text-yellow-200"
              : e.status === "created" || e.status === "linked" || e.status === "followup"
                ? "bg-[#50C878]/15 text-[#50C878]"
                : "bg-[#353535] text-gray-300"
          }`}
        >
          {statusLabel(e.status)}
          {e.status === "shadow" && e.wouldBe ? ` · would be ${statusLabel(e.wouldBe).toLowerCase()}` : ""}
        </span>
        <span className="text-gray-200 min-w-0 truncate">{e.subject || "(no subject)"}</span>
        <span className="text-xs text-gray-500 ml-auto">{fmtWhen(e.receivedAt)}</span>
      </div>
      <p className="text-xs text-gray-500 truncate">
        {e.from}
        {e.forwardedFor ? ` · via ${e.forwardedFor}` : ""}
        {e.amountCents ? ` · ${fmtCents(e.amountCents)}` : ""}
        {e.merchantRaw ? ` · ${e.merchantRaw}` : ""}
        {e.last4 ? ` · ••${e.last4}` : ""}
        {e.accountName ? ` · ${e.accountName}` : ""}
        {e.reason ? ` · ${reasonLabel(e.reason)}` : ""}
        {e.error ? ` · ${e.error}` : ""}
      </p>
    </li>
  );

  return (
    <DashboardLayout>
      <div className="space-y-4 max-w-3xl mx-auto">
        <div className="flex items-center gap-3 flex-wrap">
          <Link
            href="/settings#email-sync"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-sm hover:text-white hover:bg-[#2d2d2d] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden />
            Settings
          </Link>
          <h1 className="text-xl font-semibold text-white flex-1">Email activity</h1>
          <button
            type="button"
            disabled={busy}
            onClick={() => void reread()}
            title="Re-run emails Stash couldn't read, or couldn't match to an account, with the current readers"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#353535] text-gray-200 text-sm hover:text-white hover:bg-[#404040] transition disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Re-read
          </button>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
        {message && <p className="text-sm text-[#50C878]">{message}</p>}

        <div className="flex gap-1 flex-wrap">
          {tabButton("attention", "Needs a look", (attention?.length ?? 0) || undefined)}
          {tabButton("shadow", "Shadow report", shadow?.shadow.length || undefined)}
          {tabButton("all", "All activity")}
        </div>

        {tab === "attention" && (
          <div className="space-y-4">
            {unknown.length > 0 && (
              <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
                <h2 className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark text-white font-medium">Unknown account</h2>
                <ul className="divide-y divide-charcoal-dark">
                  {unknown.map((g) => {
                    const key = `${g.parserId}|${g.last4}|${g.forwardedFrom}`;
                    return (
                      <li key={key} className="p-3 flex items-center gap-2 flex-wrap text-sm">
                        <span className="text-gray-200 flex-1 min-w-[12rem]">
                          {g.parserLabel} alerts{" "}
                          {g.last4 ? `for card ••${g.last4}` : g.forwardedFrom ? `forwarded by ${g.forwardedFrom}` : "(no identifier)"}{" "}
                          <span className="text-gray-500">({g.count} email{g.count === 1 ? "" : "s"})</span>
                        </span>
                        {g.last4 || g.forwardedFrom ? (
                          <>
                            <select
                              value={assignTo[key] ?? ""}
                              onChange={(e) => setAssignTo((prev) => ({ ...prev, [key]: e.target.value }))}
                              className="rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1.5 text-sm text-white"
                            >
                              <option value="">Which account?</option>
                              {activeAccounts.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              disabled={busy || !assignTo[key]}
                              onClick={() => void assign(g)}
                              className="rounded-md bg-[#50C878] px-3 py-1.5 text-sm font-semibold text-charcoal disabled:opacity-50"
                            >
                              Assign
                            </button>
                          </>
                        ) : (
                          <span className="text-xs text-gray-500">{reasonLabel(g.reason)}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
              <h2 className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark text-white font-medium">
                Couldn&apos;t read
              </h2>
              {attention === null ? (
                <p className="p-4 text-sm text-gray-400">Loading…</p>
              ) : attention.filter((e) => e.status !== "unknown_account").length === 0 ? (
                <p className="p-4 text-sm text-gray-400">Nothing here.</p>
              ) : (
                <ul className="divide-y divide-charcoal-dark">
                  {attention.filter((e) => e.status !== "unknown_account").map(eventLine)}
                </ul>
              )}
              <p className="px-4 py-3 border-t border-charcoal-dark text-xs text-gray-500">
                &quot;No reader for this sender yet&quot; is expected until a reader exists for that bank — these
                emails are kept, and Re-read runs them again once one does. A failed sender check is never re-read.
              </p>
            </section>
          </div>
        )}

        {tab === "shadow" && (
          <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
            <h2 className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark text-white font-medium">
              What email sync would have done — last 14 days
            </h2>
            {shadowDays.length === 0 ? (
              <p className="p-4 text-sm text-gray-400">No shadow results yet.</p>
            ) : (
              <ul className="divide-y divide-charcoal-dark">
                {shadowDays.map(([day, rows]) => (
                  <li key={day} className="p-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="text-xs text-gray-500 mb-1">{day} · from alerts</p>
                      {rows.shadow.length === 0 ? (
                        <p className="text-xs text-gray-600">—</p>
                      ) : (
                        rows.shadow.map((r) => (
                          <p key={r.id} className="text-sm text-gray-200">
                            {r.action === "create" ? "would add" : statusLabel(r.wouldBe).toLowerCase()}{" "}
                            {fmtCents(r.amountCents)} · {r.merchantName ?? "?"}{" "}
                            <span className="text-xs text-gray-500">
                              · {r.accountName}
                              {r.category ? ` · ${r.category}${r.reviewStatus === "needs_review" ? " (ask)" : ""}` : ""}
                              {r.reason ? ` · ${reasonLabel(r.reason)}` : ""}
                            </span>
                          </p>
                        ))
                      )}
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 mb-1">{day} · logged by hand</p>
                      {rows.manual.length === 0 ? (
                        <p className="text-xs text-gray-600">—</p>
                      ) : (
                        rows.manual.map((m) => (
                          <p key={m.id} className="text-sm text-gray-300">
                            {fmtDollars(m.amount)} · {m.description || m.category}{" "}
                            <span className="text-xs text-gray-500">· {m.category}</span>
                          </p>
                        ))
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="px-4 py-3 border-t border-charcoal-dark text-xs text-gray-500">
              When every real purchase on the left matches what you logged on the right for a week, switch Email
              sync to Live in Settings.
            </p>
          </section>
        )}

        {tab === "all" && (
          <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center gap-2">
              <h2 className="text-white font-medium flex-1">Recent emails</h2>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-sm text-white"
              >
                <option value="">All statuses</option>
                {["created", "linked", "followup", "duplicate", "ignored", "shadow", "unparsed", "unknown_account", "unauthenticated", "ambiguous", "followup_ignored_reconciled", "received"].map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
            </div>
            {events === null ? (
              <p className="p-4 text-sm text-gray-400">Loading…</p>
            ) : events.length === 0 ? (
              <p className="p-4 text-sm text-gray-400">No emails yet.</p>
            ) : (
              <ul className="divide-y divide-charcoal-dark">{events.map(eventLine)}</ul>
            )}
          </section>
        )}
      </div>
    </DashboardLayout>
  );
}
