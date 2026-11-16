"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2, Scissors } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { useAccounts } from "@/contexts/AccountsContext";
import { useRefresh } from "@/contexts/RefreshContext";
import { EXPENSE_TYPE_OPTIONS, CATEGORY_COLORS } from "@/lib/constants";
import { fmtDollars } from "@/lib/emailSyncLabels";

type Item = {
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
  merchant: { id: string; displayName: string; mode: string; shortlist: string[]; defaultCategory: string | null } | null;
};
type Detail = {
  item: Item;
  fromEmail: boolean;
  /** A Venmo payment to a person — never offered a guess (lib/email/rules.ts). */
  person?: boolean;
  reviewedByName: string | null;
  amountHistory: Array<{ oldAmount: number; newAmount: number; reason: string; changedAt: string }>;
};

/**
 * The categorize screen (plan §5.10): big buttons for the shortlist or the
 * guess, Other for the full grid, and the two rule toggles. Push
 * notifications deep-link here.
 */
export default function CategorizeItemPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(String(params?.id ?? ""));
  const router = useRouter();
  const { activeAccounts, labelFor } = useAccounts();
  const { triggerRefresh } = useRefresh();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [always, setAlways] = useState(false);
  const [addToShortlist, setAddToShortlist] = useState(false);
  const [alreadyFiled, setAlreadyFiled] = useState<{ category: string | null; by: string | null; you: boolean } | null>(
    null,
  );
  const [changing, setChanging] = useState(false);
  // Editable before you pick; saved together with the pick (or on its own via
  // "Save description" when there's nothing left to pick).
  const [description, setDescription] = useState("");
  const [descriptionSaved, setDescriptionSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/categorize/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Failed to load (${res.status})`);
      setDetail(data as Detail);
      setDescription((data as Detail).item.description ?? "");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const item = detail?.item ?? null;
  const merchant = item?.merchant ?? null;
  const primaryChoices = useMemo(() => {
    if (!item) return [];
    if (merchant?.mode === "ask_shortlist" && merchant.shortlist.length > 0) return merchant.shortlist;
    const guess = item.category ?? (detail?.person ? null : merchant?.defaultCategory ?? null);
    return guess ? [guess] : [];
  }, [item, merchant, detail?.person]);

  const descriptionChanged = item !== null && description.trim() !== (item.description ?? "").trim();
  /** Sent with any save, only when edited — an untouched field never rewrites the row. */
  const descriptionPatch = useMemo(
    () => (descriptionChanged ? { description: description.trim() } : {}),
    [descriptionChanged, description],
  );
  /** Is a pick (category or account) on screen that will carry the description? */
  const pickPending = item
    ? item.kind === "transfer"
      ? item.reviewStatus === "needs_review"
      : alreadyFiled !== null || changing || item.reviewStatus === "needs_review"
    : false;

  const answer = useCallback(
    async (category: string) => {
      setBusy(true);
      setError("");
      try {
        const res = await fetch(`/api/categorize/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category, always, addToShortlist, ...descriptionPatch }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) {
          setAlreadyFiled({ category: data.category ?? null, by: data.reviewedByName ?? null, you: data.reviewedByYou === true });
          return;
        }
        if (!res.ok) throw new Error(data?.error ?? "Failed to save");
        triggerRefresh();
        router.push("/categorize");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save");
      } finally {
        setBusy(false);
      }
    },
    [id, always, addToShortlist, descriptionPatch, router, triggerRefresh],
  );

  /** "Change" after Already filed: the ordinary edit route. */
  const change = useCallback(
    async (category: string) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/transactions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expenseType: category, ...descriptionPatch }),
        });
        if (!res.ok) throw new Error("Failed to change");
        triggerRefresh();
        router.push("/categorize");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to change");
      } finally {
        setBusy(false);
      }
    },
    [id, descriptionPatch, router, triggerRefresh],
  );

  /** Description only — for a row that's already filed (nothing left to pick). */
  const saveDescription = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/transactions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description.trim() }),
      });
      if (!res.ok) throw new Error("Failed to save the description");
      setDetail((d) => (d ? { ...d, item: { ...d.item, description: description.trim() } } : d));
      setDescriptionSaved(true);
      triggerRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the description");
    } finally {
      setBusy(false);
    }
  }, [id, description, triggerRefresh]);

  const setTransferSide = useCallback(
    async (accountId: string) => {
      if (!item) return;
      setBusy(true);
      try {
        const body = item.transferTo === null ? { transferTo: accountId } : { transferFrom: accountId };
        const res = await fetch(`/api/transactions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, ...descriptionPatch }),
        });
        if (!res.ok) throw new Error("Failed to save");
        triggerRefresh();
        router.push("/categorize");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed");
      } finally {
        setBusy(false);
      }
    },
    [id, item, descriptionPatch, router, triggerRefresh],
  );

  const split = useCallback(async () => {
    if (!window.confirm("Split this back into the two separate purchases the alerts described?")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/transactions/${encodeURIComponent(id)}/split`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Failed to split");
      triggerRefresh();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to split");
    } finally {
      setBusy(false);
    }
  }, [id, load, triggerRefresh]);

  const bigButton = (category: string) => (
    <button
      key={category}
      type="button"
      disabled={busy}
      onClick={() => void (alreadyFiled || changing ? change(category) : answer(category))}
      className="flex items-center gap-3 rounded-xl border border-charcoal-dark bg-[#2C2C2C] px-4 py-4 text-left text-white text-lg hover:border-[#50C878]/60 hover:bg-[#333] transition disabled:opacity-50"
    >
      <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_COLORS[category] ?? "#50C878" }} />
      {category}
    </button>
  );

  const grid = (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {EXPENSE_TYPE_OPTIONS.map((category) => (
        <button
          key={category}
          type="button"
          disabled={busy}
          onClick={() => void (alreadyFiled || changing ? change(category) : answer(category))}
          className="rounded-lg border border-charcoal-dark bg-[#2C2C2C] px-3 py-2.5 text-sm text-gray-200 text-left hover:border-[#50C878]/60 hover:text-white transition disabled:opacity-50"
        >
          {category}
        </button>
      ))}
    </div>
  );

  const venmoAccounts = activeAccounts.filter((a) => a.alertSource === "venmo");
  const sidePicker = venmoAccounts.length > 0 ? venmoAccounts : activeAccounts;

  return (
    <DashboardLayout>
      <div className="space-y-5 max-w-lg mx-auto">
        <div className="flex items-center gap-3">
          <Link
            href="/categorize"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-sm hover:text-white hover:bg-[#2d2d2d] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden />
            To categorize
          </Link>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
        {!detail && !error && (
          <p className="text-sm text-gray-400 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </p>
        )}

        {item && (
          <>
            <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-5 text-center space-y-1">
              <p className="text-3xl font-semibold text-white tabular-nums">{fmtDollars(item.amount)}</p>
              <p className="text-lg text-gray-200">
                {item.kind === "transfer" ? item.description : merchant?.displayName ?? item.description}
              </p>
              <p className="text-sm text-gray-500">
                {item.date}
                {item.kind !== "transfer" && item.account ? ` · ${labelFor(item.account)}` : ""}
                {item.isPending ? " · pending" : ""}
              </p>
              {item.originalAmount !== null && (
                <p className="text-xs text-gray-400">updated from {fmtDollars(item.originalAmount)}</p>
              )}
              {item.autoMerged && (
                <div className="pt-2">
                  <span className="text-xs text-yellow-200/90 mr-2">auto-merged from two alerts</span>
                  <button
                    type="button"
                    onClick={() => void split()}
                    disabled={busy}
                    className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white underline disabled:opacity-50"
                  >
                    <Scissors className="w-3 h-3" /> Split back into two
                  </button>
                </div>
              )}
            </div>

            <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-3 space-y-2">
              <label htmlFor="categorize-description" className="block text-xs text-gray-400">
                Description
              </label>
              {/* text-base (16px) so iOS doesn't zoom the page when the field is focused. */}
              <input
                id="categorize-description"
                type="text"
                value={description}
                maxLength={500}
                placeholder="Add a description"
                onChange={(e) => {
                  setDescription(e.target.value);
                  setDescriptionSaved(false);
                }}
                className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-base text-gray-200 placeholder-gray-500 focus:border-accent focus:ring-1 focus:ring-accent outline-none"
              />
              {descriptionChanged ? (
                pickPending ? (
                  <p className="text-xs text-gray-500">Saved with your pick below.</p>
                ) : (
                  <button
                    type="button"
                    onClick={() => void saveDescription()}
                    disabled={busy}
                    className="rounded-md bg-[#353535] px-3 py-1.5 text-sm text-gray-200 hover:text-white hover:bg-[#404040] transition disabled:opacity-50"
                  >
                    Save description
                  </button>
                )
              ) : descriptionSaved ? (
                <p className="text-xs text-[#50C878] flex items-center gap-1">
                  <Check className="w-3 h-3" aria-hidden /> Saved
                </p>
              ) : null}
            </div>

            {item.kind === "transfer" ? (
              item.reviewStatus === "needs_review" ? (
                <div className="space-y-2">
                  <h2 className="text-white font-medium">
                    {item.transferTo === null ? "Which account did this go to?" : "Which account did this come from?"}
                  </h2>
                  <p className="text-xs text-gray-400">
                    {labelFor(item.transferFrom ?? item.transferTo)} — {item.description}. It fills in by itself
                    when the matching Venmo email arrives.
                  </p>
                  <div className="grid gap-2">
                    {sidePicker.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        disabled={busy}
                        onClick={() => void setTransferSide(a.id)}
                        className="rounded-xl border border-charcoal-dark bg-[#2C2C2C] px-4 py-3 text-left text-white hover:border-[#50C878]/60 transition disabled:opacity-50"
                      >
                        {a.name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-300 text-center">
                  {labelFor(item.transferFrom)} → {labelFor(item.transferTo)}
                </p>
              )
            ) : alreadyFiled || (item.reviewStatus === "confirmed" && !changing) ? (
              <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4 space-y-3">
                <p className="text-sm text-gray-200 flex items-center gap-2">
                  <Check className="w-4 h-4 text-[#50C878]" />
                  {alreadyFiled
                    ? `Already filed${alreadyFiled.you ? " by you" : alreadyFiled.by ? ` by ${alreadyFiled.by}` : ""} as ${alreadyFiled.category ?? "—"}.`
                    : `Filed as ${item.category ?? "—"}${detail?.reviewedByName ? ` by ${detail.reviewedByName}` : ""}${
                        item.categorizedBy === "guess" ? " (Stash's guess — unconfirmed)" : ""
                      }.`}
                </p>
                {alreadyFiled || changing ? (
                  grid
                ) : (
                  <button
                    type="button"
                    onClick={() => setChanging(true)}
                    className="rounded-md bg-[#353535] px-3 py-2 text-sm text-gray-200 hover:text-white hover:bg-[#404040] transition"
                  >
                    {item.categorizedBy === "guess" ? "Confirm or change" : "Change"}
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {changing && item.reviewStatus === "confirmed" ? (
                  grid
                ) : (
                  <>
                    {primaryChoices.length > 0 && (
                      <div className="grid gap-2">{primaryChoices.map((c) => bigButton(c))}</div>
                    )}
                    {showAll || primaryChoices.length === 0 ? (
                      grid
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowAll(true)}
                        className="w-full rounded-xl border border-dashed border-charcoal-dark px-4 py-3 text-gray-300 hover:text-white hover:border-gray-500 transition"
                      >
                        Other…
                      </button>
                    )}
                    {merchant && (
                      <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-3 space-y-2 text-sm">
                        <label className="flex items-center gap-2 text-gray-200">
                          <input
                            type="checkbox"
                            checked={always}
                            onChange={(e) => {
                              setAlways(e.target.checked);
                              if (e.target.checked) setAddToShortlist(false);
                            }}
                            className="accent-[#50C878]"
                          />
                          Always file {merchant.displayName} this way
                        </label>
                        <label className="flex items-center gap-2 text-gray-200">
                          <input
                            type="checkbox"
                            checked={addToShortlist}
                            onChange={(e) => {
                              setAddToShortlist(e.target.checked);
                              if (e.target.checked) setAlways(false);
                            }}
                            className="accent-[#50C878]"
                          />
                          Add my pick to {merchant.displayName}&apos;s shortlist
                        </label>
                        <p className="text-xs text-gray-500">
                          Without these, your answer files only this purchase. Manage rules on the{" "}
                          <Link href="/rules" className="text-[#50C878] hover:brightness-110">
                            Rules
                          </Link>{" "}
                          page.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {detail && detail.amountHistory.length > 0 && (
              <div className="text-xs text-gray-500 space-y-0.5">
                {detail.amountHistory.map((h, i) => (
                  <p key={i}>
                    {fmtDollars(h.oldAmount)} → {fmtDollars(h.newAmount)} ({h.reason.replace("_", " ")})
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
