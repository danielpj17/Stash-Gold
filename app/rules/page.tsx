"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Search } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { useRefresh } from "@/contexts/RefreshContext";
import { EXPENSE_CATEGORIES } from "@/lib/constants";
import { fmtWhen } from "@/lib/emailSyncLabels";

type Alias = { key: string; exampleRaw: string; lastSeenAt: string | null };
type Merchant = {
  id: string;
  displayName: string;
  mode: "auto" | "ask_shortlist" | "ask_all";
  category: string | null;
  shortlist: string[];
  defaultCategory: string | null;
  lastSeenAt: string | null;
  transactionCount: number;
  aliases: Alias[];
};

const MODE_LABELS: Record<Merchant["mode"], string> = {
  auto: "Always file as…",
  ask_shortlist: "Ask, from a shortlist",
  ask_all: "Ask, any category",
};

/**
 * Merchant rules (plan §5.5, §5.10). Editing a rule never touches past rows;
 * "Apply to past transactions" is the one explicit way to re-file history,
 * and it shows a count first.
 */
export default function RulesPage() {
  const { triggerRefresh } = useRefresh();
  const [merchants, setMerchants] = useState<Merchant[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/merchants", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Failed to load");
      setMerchants((data as { merchants: Merchant[] }).merchants);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (m: Merchant, patch: Partial<Merchant>) => {
      setBusy(true);
      setError("");
      try {
        const res = await fetch(`/api/merchants/${m.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? "Failed to save");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const applyToPast = useCallback(
    async (m: Merchant, category: string) => {
      setBusy(true);
      setError("");
      try {
        const preview = await fetch(`/api/merchants/${m.id}?category=${encodeURIComponent(category)}`, { cache: "no-store" });
        const p = (await preview.json()) as { total: number; personFiled: Array<{ category: string; count: number }> };
        if (!preview.ok) throw new Error("Failed to count");
        if (p.total === 0) {
          window.alert(`Every ${m.displayName} transaction is already filed as ${category}.`);
          return;
        }
        const filed = p.personFiled.filter((x) => x.category !== category);
        const detail = filed.length
          ? ` — ${filed.map((x) => `${x.count} of them you filed as ${x.category}`).join(", ")}`
          : "";
        if (!window.confirm(`Re-file ${p.total} ${m.displayName} transaction${p.total === 1 ? "" : "s"} as ${category}${detail}?`)) {
          return;
        }
        const res = await fetch(`/api/merchants/${m.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? "Failed");
        triggerRefresh();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed");
      } finally {
        setBusy(false);
      }
    },
    [load, triggerRefresh],
  );

  const merge = useCallback(
    async (from: Merchant, intoId: string) => {
      const into = merchants?.find((m) => m.id === intoId);
      if (!into) return;
      if (!window.confirm(`Merge "${from.displayName}" into "${into.displayName}"? Its raw names and transactions move over; "${into.displayName}"'s rule applies.`)) {
        return;
      }
      setBusy(true);
      try {
        const res = await fetch("/api/merchants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mergeFrom: from.id, mergeInto: into.id }),
        });
        if (!res.ok) throw new Error("Failed to merge");
        setOpen(into.id);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to merge");
      } finally {
        setBusy(false);
      }
    },
    [load, merchants],
  );

  const moveAlias = useCallback(
    async (alias: Alias, target: string) => {
      setBusy(true);
      try {
        const res = await fetch("/api/merchants", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(target === "__split" ? { key: alias.key, split: true } : { key: alias.key, merchantId: target }),
        });
        if (!res.ok) throw new Error("Failed to move");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to move");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!merchants) return [];
    if (!q) return merchants;
    return merchants.filter(
      (m) => m.displayName.toLowerCase().includes(q) || m.aliases.some((a) => a.exampleRaw.toLowerCase().includes(q)),
    );
  }, [merchants, query]);

  const select = "rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1.5 text-sm text-white";

  return (
    <DashboardLayout>
      <div className="space-y-4 max-w-3xl mx-auto">
        <div className="flex items-center gap-3">
          <Link
            href="/categorize"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-sm hover:text-white hover:bg-[#2d2d2d] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden />
            To categorize
          </Link>
          <h1 className="text-xl font-semibold text-white flex-1">Merchant rules</h1>
          {busy && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
        </div>
        <p className="text-xs text-gray-400">
          How card-alert purchases get filed. A new merchant is always asked the first time. Changing a rule
          affects future purchases only — use <b>Apply to past</b> to re-file history.
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="relative">
          <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search merchants"
            className="w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark pl-9 pr-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-[#50C878]"
          />
        </div>

        {!merchants ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : shown.length === 0 ? (
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-6 text-center text-sm text-gray-400">
            No merchants yet — they appear as card alerts arrive.
          </div>
        ) : (
          <ul className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden divide-y divide-charcoal-dark">
            {shown.map((m) => {
              const isOpen = open === m.id;
              const ruleSummary =
                m.mode === "auto"
                  ? `Always ${m.category}`
                  : m.mode === "ask_shortlist"
                    ? `Ask: ${m.shortlist.join(" / ")}`
                    : m.defaultCategory
                      ? `Ask (guess ${m.defaultCategory})`
                      : "Ask";
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : m.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[#2c2c2c]"
                  >
                    {isOpen ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-white truncate">{m.displayName}</span>
                      <span className="block text-xs text-gray-500 truncate">
                        {ruleSummary} · {m.transactionCount} purchase{m.transactionCount === 1 ? "" : "s"} · seen{" "}
                        {fmtWhen(m.lastSeenAt)}
                      </span>
                    </span>
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-4 pt-1 space-y-3 text-sm">
                      <label className="block">
                        <span className="block text-xs text-gray-400 mb-1">Name</span>
                        <input
                          defaultValue={m.displayName}
                          maxLength={80}
                          onBlur={(e) => {
                            const next = e.target.value.trim();
                            if (next && next !== m.displayName) void save(m, { displayName: next });
                          }}
                          className="w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-1.5 text-white focus:outline-none focus:border-[#50C878]"
                        />
                      </label>

                      <div className="flex gap-2 flex-wrap items-end">
                        <label>
                          <span className="block text-xs text-gray-400 mb-1">Rule</span>
                          <select
                            value={m.mode}
                            className={select}
                            onChange={(e) => {
                              const mode = e.target.value as Merchant["mode"];
                              if (mode === "auto") {
                                void save(m, { mode, category: m.category ?? m.defaultCategory ?? EXPENSE_CATEGORIES[0] });
                              } else if (mode === "ask_shortlist") {
                                const shortlist = m.shortlist.length ? m.shortlist : m.defaultCategory ? [m.defaultCategory] : [EXPENSE_CATEGORIES[0]];
                                void save(m, { mode, shortlist });
                              } else {
                                void save(m, { mode });
                              }
                            }}
                          >
                            {(Object.keys(MODE_LABELS) as Merchant["mode"][]).map((k) => (
                              <option key={k} value={k}>
                                {MODE_LABELS[k]}
                              </option>
                            ))}
                          </select>
                        </label>
                        {m.mode === "auto" && (
                          <label>
                            <span className="block text-xs text-gray-400 mb-1">Category</span>
                            <select value={m.category ?? ""} className={select} onChange={(e) => void save(m, { category: e.target.value })}>
                              {EXPENSE_CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <label>
                          <span className="block text-xs text-gray-400 mb-1">Guess (pre-selected, counts unconfirmed)</span>
                          <select
                            value={m.defaultCategory ?? ""}
                            className={select}
                            onChange={(e) => void save(m, { defaultCategory: e.target.value || null })}
                          >
                            <option value="">No guess</option>
                            {EXPENSE_CATEGORIES.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      {m.mode === "ask_shortlist" && (
                        <div>
                          <span className="block text-xs text-gray-400 mb-1">Shortlist (&quot;Other&quot; is always offered)</span>
                          <div className="flex flex-wrap gap-1.5">
                            {EXPENSE_CATEGORIES.map((c) => {
                              const on = m.shortlist.includes(c);
                              return (
                                <button
                                  key={c}
                                  type="button"
                                  disabled={busy || (on && m.shortlist.length === 1)}
                                  onClick={() =>
                                    void save(m, { shortlist: on ? m.shortlist.filter((x) => x !== c) : [...m.shortlist, c] })
                                  }
                                  className={`px-2 py-1 rounded-full text-xs border transition ${
                                    on ? "bg-[#50C878]/15 border-[#50C878]/50 text-[#50C878]" : "border-charcoal-dark text-gray-400 hover:text-white"
                                  }`}
                                >
                                  {c}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <div>
                        <span className="block text-xs text-gray-400 mb-1">Raw names seen in alerts</span>
                        <ul className="space-y-1">
                          {m.aliases.map((a) => (
                            <li key={a.key} className="flex items-center gap-2 flex-wrap">
                              <code className="text-xs text-gray-300 flex-1 min-w-0 break-all">{a.exampleRaw}</code>
                              {merchants.length > 1 || m.aliases.length > 1 ? (
                                <select
                                  value=""
                                  className={`${select} text-xs`}
                                  onChange={(e) => e.target.value && void moveAlias(a, e.target.value)}
                                >
                                  <option value="">Move to…</option>
                                  {m.aliases.length > 1 && <option value="__split">Its own merchant</option>}
                                  {merchants
                                    .filter((x) => x.id !== m.id)
                                    .map((x) => (
                                      <option key={x.id} value={x.id}>
                                        {x.displayName}
                                      </option>
                                    ))}
                                </select>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div className="flex gap-2 flex-wrap items-center pt-1 border-t border-charcoal-dark">
                        <select
                          value=""
                          className={`${select} mt-3`}
                          onChange={(e) => e.target.value && void applyToPast(m, e.target.value)}
                        >
                          <option value="">Apply to past transactions…</option>
                          {EXPENSE_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              Re-file all as {c}
                            </option>
                          ))}
                        </select>
                        {merchants.length > 1 && (
                          <select value="" className={`${select} mt-3`} onChange={(e) => e.target.value && void merge(m, e.target.value)}>
                            <option value="">Merge into…</option>
                            {merchants
                              .filter((x) => x.id !== m.id)
                              .map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.displayName}
                                </option>
                              ))}
                          </select>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </DashboardLayout>
  );
}
