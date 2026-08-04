"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { FinancialAccount, StoredCsvProfile } from "@/lib/accounts";

type ColumnRole = "ignore" | "date" | "amount" | "description" | "debit" | "credit";

type PreviewResponse = {
  detected: Partial<StoredCsvProfile> & { isComplete?: boolean };
  preview: Array<{ date: string; amount: number; description: string }>;
  parseableCount: number;
  totalRows: number;
  sampleRows: string[][];
  columnCount: number;
};

type DraftProfile = {
  hasHeader: boolean;
  headerRowIndex: number;
  dateIndex: number | null;
  amountIndex: number | null;
  descriptionIndex: number | null;
  debitIndex: number | null;
  creditIndex: number | null;
  outflowIsPositive: boolean;
  deriveDateFromDescription: boolean;
  detectedAutomatically: boolean;
  sampleHeaders: string[];
};

const ROLE_OPTIONS: Array<{ value: ColumnRole; label: string }> = [
  { value: "ignore", label: "Ignore" },
  { value: "date", label: "Date" },
  { value: "amount", label: "Amount" },
  { value: "description", label: "Description" },
  { value: "debit", label: "Debit / money out" },
  { value: "credit", label: "Credit / money in" },
];

function roleForColumn(profile: DraftProfile, index: number): ColumnRole {
  if (profile.dateIndex === index) return "date";
  if (profile.amountIndex === index) return "amount";
  if (profile.descriptionIndex === index) return "description";
  if (profile.debitIndex === index) return "debit";
  if (profile.creditIndex === index) return "credit";
  return "ignore";
}

/** Each role belongs to exactly one column, so assigning clears the previous holder. */
function assignRole(profile: DraftProfile, index: number, role: ColumnRole): DraftProfile {
  const next: DraftProfile = { ...profile };
  if (next.dateIndex === index) next.dateIndex = null;
  if (next.amountIndex === index) next.amountIndex = null;
  if (next.descriptionIndex === index) next.descriptionIndex = null;
  if (next.debitIndex === index) next.debitIndex = null;
  if (next.creditIndex === index) next.creditIndex = null;

  if (role === "date") next.dateIndex = index;
  if (role === "amount") {
    next.amountIndex = index;
    // A single amount column and a debit/credit pair are mutually exclusive.
    next.debitIndex = null;
    next.creditIndex = null;
  }
  if (role === "description") next.descriptionIndex = index;
  if (role === "debit") {
    next.debitIndex = index;
    next.amountIndex = null;
  }
  if (role === "credit") {
    next.creditIndex = index;
    next.amountIndex = null;
  }
  return next;
}

const fmtMoney = (n: number) =>
  (n < 0 ? "-$" : "$") +
  Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Confirm how a bank's CSV should be read.
 *
 * Auto-detection only ever fills in a starting guess — the user sees a live
 * preview produced by the real parser and has to accept it. A silently-wrong
 * mapping would produce plausible-but-wrong transaction hashes, and claims key
 * off those hashes.
 */
export default function CsvMappingModal({
  account,
  rows,
  onCancel,
  onSaved,
}: {
  account: FinancialAccount;
  rows: string[][];
  onCancel: () => void;
  onSaved: (updatedAccounts: FinancialAccount[]) => void;
}) {
  const [profile, setProfile] = useState<DraftProfile | null>(null);
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fetchPreview = useCallback(
    async (draft: DraftProfile | null) => {
      try {
        const res = await fetch(`/api/accounts/${account.id}/csv-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows, profile: draft }),
        });
        const body = (await res.json()) as PreviewResponse & { error?: string };
        if (!res.ok) throw new Error(body?.error ?? `Preview failed (${res.status})`);
        setData(body);
        setError("");
        return body;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't read that file");
        return null;
      }
    },
    [account.id, rows],
  );

  // First load: seed from the saved profile if there is one, else the guess.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const body = await fetchPreview(null);
      if (cancelled || !body) {
        setLoading(false);
        return;
      }
      const source = account.csvProfile ?? body.detected;
      setProfile({
        hasHeader: source?.hasHeader ?? true,
        headerRowIndex: source?.headerRowIndex ?? 0,
        dateIndex: source?.dateIndex ?? null,
        amountIndex: source?.amountIndex ?? null,
        descriptionIndex: source?.descriptionIndex ?? null,
        debitIndex: source?.debitIndex ?? null,
        creditIndex: source?.creditIndex ?? null,
        outflowIsPositive: source?.outflowIsPositive ?? false,
        deriveDateFromDescription: source?.deriveDateFromDescription ?? false,
        detectedAutomatically: !account.csvProfile,
        sampleHeaders: body.detected?.sampleHeaders ?? [],
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally first-mount only; later previews are driven by edits below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-preview whenever the mapping changes so the sample below is always live.
  useEffect(() => {
    if (!profile) return;
    void fetchPreview(profile);
  }, [profile, fetchPreview]);

  const isUsable = useMemo(() => {
    if (!profile) return false;
    const hasAmount =
      profile.amountIndex !== null ||
      (profile.debitIndex !== null && profile.creditIndex !== null);
    return profile.dateIndex !== null && profile.descriptionIndex !== null && hasAmount;
  }, [profile]);

  const handleSave = useCallback(async () => {
    if (!profile || !isUsable) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvProfile: profile }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `Failed to save (${res.status})`);
      onSaved(Array.isArray(body.accounts) ? body.accounts : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save CSV format");
      setSaving(false);
    }
  }, [profile, isUsable, account.id, onSaved]);

  const columnCount = data?.columnCount ?? 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 p-4 flex items-center justify-center overflow-y-auto">
      <div className="w-full max-w-4xl my-8 rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
        <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
          <h3 className="text-white font-semibold">Set up the CSV format for {account.name}</h3>
          <p className="text-xs text-gray-400 mt-1">
            Tell Stash which column is which. You only do this once per account — later uploads
            use the same setup.
          </p>
        </div>

        {loading ? (
          <div className="p-6 flex items-center gap-2 text-gray-300">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading the file…
          </div>
        ) : !profile ? (
          <div className="p-6 text-red-400 text-sm">{error || "Couldn't read that file."}</div>
        ) : (
          <div className="p-4 space-y-5">
            {profile.detectedAutomatically && (
              <p className="text-xs text-[#50C878] bg-[#50C878]/10 rounded-md px-3 py-2">
                We guessed the columns below. Check the preview at the bottom and correct anything
                that looks wrong.
              </p>
            )}

            {/* Column mapping over a sample of the real file */}
            <div className="overflow-x-auto">
              <table className="text-xs min-w-full">
                <thead>
                  <tr>
                    {Array.from({ length: columnCount }).map((_, index) => (
                      <th key={index} className="p-1 align-top text-left">
                        <select
                          value={roleForColumn(profile, index)}
                          onChange={(e) =>
                            setProfile((prev) =>
                              prev ? assignRole(prev, index, e.target.value as ColumnRole) : prev,
                            )
                          }
                          aria-label={`Role for column ${index + 1}`}
                          className="w-full rounded bg-[#1f1f1f] border border-charcoal-dark px-1.5 py-1 text-white focus:outline-none focus:border-[#50C878]"
                        >
                          {ROLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        {profile.sampleHeaders[index] && (
                          <div className="mt-1 text-gray-500 truncate max-w-[10rem]">
                            {profile.sampleHeaders[index]}
                          </div>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data?.sampleRows ?? []).map((row, r) => (
                    <tr key={r} className={r % 2 ? "bg-[#2C2C2C]" : ""}>
                      {Array.from({ length: columnCount }).map((_, c) => (
                        <td
                          key={c}
                          className="px-1.5 py-1 text-gray-300 truncate max-w-[12rem]"
                          title={row[c] ?? ""}
                        >
                          {row[c] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Conventions */}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-start gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={profile.outflowIsPositive}
                  onChange={(e) =>
                    setProfile((prev) =>
                      prev ? { ...prev, outflowIsPositive: e.target.checked } : prev,
                    )
                  }
                  className="mt-1 accent-[#50C878]"
                />
                <span>
                  Purchases show as <strong>positive</strong> numbers
                  <span className="block text-xs text-gray-500">
                    Usual for credit cards. Checking accounts normally show purchases as negative.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={profile.deriveDateFromDescription}
                  onChange={(e) =>
                    setProfile((prev) =>
                      prev ? { ...prev, deriveDateFromDescription: e.target.checked } : prev,
                    )
                  }
                  className="mt-1 accent-[#50C878]"
                />
                <span>
                  Use the purchase date from the description
                  <span className="block text-xs text-gray-500">
                    For banks that write &quot;PURCHASE AUTHORIZED ON 03/14&quot; and post a day or
                    two later.
                  </span>
                </span>
              </label>
            </div>

            {/* Live preview through the real parser */}
            <div className="rounded-lg border border-charcoal-dark overflow-hidden">
              <div className="px-3 py-2 bg-[#2C2C2C] flex items-center justify-between gap-2">
                <span className="text-sm text-white font-medium">Preview</span>
                <span
                  className={`text-xs ${
                    (data?.parseableCount ?? 0) > 0 ? "text-[#50C878]" : "text-yellow-300/90"
                  }`}
                >
                  {data?.parseableCount ?? 0} of {data?.totalRows ?? 0} rows read
                </span>
              </div>
              {!isUsable ? (
                <p className="p-3 text-sm text-yellow-300/90">
                  Pick a Date column, a Description column, and either an Amount column or both a
                  Debit and a Credit column.
                </p>
              ) : (data?.preview.length ?? 0) === 0 ? (
                <p className="p-3 text-sm text-yellow-300/90">
                  No transactions could be read with this mapping. Try different columns.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-400 border-b border-charcoal-dark">
                      <th className="px-3 py-1.5">Date</th>
                      <th className="px-3 py-1.5">Description</th>
                      <th className="px-3 py-1.5 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.preview ?? []).map((row, i) => (
                      <tr key={i} className={i % 2 ? "bg-[#2C2C2C]" : ""}>
                        <td className="px-3 py-1.5 text-gray-300 whitespace-nowrap">{row.date}</td>
                        <td className="px-3 py-1.5 text-gray-300">{row.description}</td>
                        <td
                          className={`px-3 py-1.5 text-right whitespace-nowrap ${
                            row.amount < 0 ? "text-red-400" : "text-[#50C878]"
                          }`}
                        >
                          {fmtMoney(row.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
        )}

        <div className="px-4 py-3 bg-[#2C2C2C] border-t border-charcoal-dark flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-md text-gray-300 hover:text-white hover:bg-[#353535] transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!isUsable || saving}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-[#50C878] font-semibold text-charcoal disabled:opacity-50 hover:brightness-110 transition"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save and continue
          </button>
        </div>
      </div>
    </div>
  );
}
