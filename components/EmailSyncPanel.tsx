"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Check, Copy, KeyRound, Loader2, Plus } from "lucide-react";
import { fmtWhen, statusLabel } from "@/lib/emailSyncLabels";

type Status = {
  settings: {
    mode: "shadow" | "live";
    answerTimeoutHours: number;
    internalCounterparties: string[];
    lastHeartbeatAt: string | null;
    lastHeartbeatError: string | null;
    lastPollAt: string | null;
    lastIngestAt: string | null;
    pollerVersion: string | null;
    lastPollerFailureAt: string | null;
  };
  counts: Record<string, number>;
  toCategorize: number;
  heartbeat: { ageMinutes: number | null; stale: boolean; staleAfterMinutes: number };
};

type Token = {
  id: string;
  name: string;
  prefix: string;
  purpose?: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/**
 * Settings → Email sync (plan §5.10). Chrome-free body, like HouseholdPanel.
 *
 * The KEY is the signed-in person's own (tokens are actor-scoped, so each
 * spouse could run a poller); the mode, counts and check-in are the
 * household's.
 */
export default function EmailSyncPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [names, setNames] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([
        fetch("/api/email-sync", { cache: "no-store" }),
        fetch("/api/tokens", { cache: "no-store" }),
      ]);
      const sData = await s.json().catch(() => ({}));
      if (!s.ok) throw new Error(sData?.error ?? `Failed to load (${s.status})`);
      const tData = (await t.json().catch(() => ({}))) as { tokens?: Token[] };
      setStatus(sData as Status);
      setNames(((sData as Status).settings.internalCounterparties ?? []).join(", "));
      setTokens((tData.tokens ?? []).filter((x) => x.purpose === "email"));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load email sync");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError("");
      try {
        const res = await fetch("/api/email-sync", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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

  const createKey = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Gmail poller", purpose: "email" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Failed to create key");
      setFreshKey(data.rawToken ?? null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setBusy(false);
    }
  }, [load]);

  const revoke = useCallback(
    async (token: Token) => {
      if (!window.confirm(`Revoke "${token.name}" (${token.prefix}…)? The Gmail poller stops until it gets a new key.`)) {
        return;
      }
      setBusy(true);
      try {
        const res = await fetch("/api/tokens", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: token.id }),
        });
        if (!res.ok) throw new Error("Failed to revoke");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to revoke");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const switchMode = useCallback(
    async (mode: "shadow" | "live") => {
      if (
        mode === "live" &&
        !window.confirm(
          "Switch email sync to LIVE?\n\nCard alerts will start creating real transactions. Check the shadow report " +
            "first: a week of it matching what you logged by hand is the go-ahead.\n\nEmails that arrived during shadow " +
            "are never added — you logged those by hand.",
        )
      ) {
        return;
      }
      await patch({ mode });
    },
    [patch],
  );

  if (!status && !error) {
    return (
      <p className="text-sm text-gray-400 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </p>
    );
  }

  const s = status?.settings;
  const live = tokens.filter((t) => !t.revokedAt);
  const neverCheckedIn = !s?.lastHeartbeatAt;
  const counts = status?.counts ?? {};
  const attention = (counts.unparsed ?? 0) + (counts.unknown_account ?? 0);

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-400">{error}</p>}

      <p className="text-xs text-gray-400">
        Bank, card and Venmo alert emails go to a dedicated Gmail inbox; a small Apps Script forwards each one here.{" "}
        <Link href="/guide/email-sync" className="text-[#50C878] hover:brightness-110">
          Setup guide
        </Link>
      </p>

      {/* Check-in */}
      {status && (
        <div
          className={`rounded-lg border px-3 py-2.5 text-sm space-y-1 ${
            status.heartbeat.stale ? "border-yellow-400/50 bg-yellow-400/10" : "border-charcoal-dark"
          }`}
        >
          <p className="flex items-center gap-2 text-gray-200">
            {status.heartbeat.stale && <AlertTriangle className="w-4 h-4 text-yellow-300" />}
            Last check-in: <span className="text-white">{fmtWhen(s?.lastHeartbeatAt)}</span>
            {s?.pollerVersion && <span className="text-xs text-gray-500">poller {s.pollerVersion}</span>}
          </p>
          <p className="text-xs text-gray-400">Last email: {fmtWhen(s?.lastIngestAt)}</p>
          {status.heartbeat.stale && (
            <p className="text-xs text-yellow-200">
              No check-in for over {status.heartbeat.staleAfterMinutes} minutes. The Apps Script trigger may need
              re-authorizing — open the script and run <code>setup()</code> again.
            </p>
          )}
          {s?.lastHeartbeatError && <p className="text-xs text-red-300">Poller error: {s.lastHeartbeatError}</p>}
          {s?.lastPollerFailureAt && (
            <p className="text-xs text-yellow-200">Apps Script sent a failure notice {fmtWhen(s.lastPollerFailureAt)}.</p>
          )}
          {neverCheckedIn && <p className="text-xs text-gray-500">Not set up yet — no poller has checked in.</p>}
        </div>
      )}

      {/* Key */}
      <div className="space-y-2">
        <p className="text-xs text-gray-400">Your email-sync key (goes in the Apps Script&apos;s Script Properties)</p>
        {freshKey && (
          <div className="rounded-lg border border-[#50C878]/40 bg-[#50C878]/10 p-3 space-y-2">
            <p className="text-xs text-gray-200">Copy it now — it won&apos;t be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 break-all text-xs text-white">{freshKey}</code>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(freshKey);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  } catch {
                    /* selectable on screen */
                  }
                }}
                className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-[#353535] text-gray-200 hover:text-white"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-[#50C878]" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
        {live.map((t) => (
          <div key={t.id} className="rounded-lg border border-charcoal-dark px-3 py-2 flex items-center gap-2 text-sm">
            <KeyRound className="w-4 h-4 text-gray-500 shrink-0" />
            <span className="text-gray-200">{t.name}</span>
            <code className="text-xs text-gray-500">{t.prefix}…</code>
            <span className="text-xs text-gray-500 ml-auto">used {fmtWhen(t.lastUsedAt)}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void revoke(t)}
              aria-label="Revoke key"
              className="text-gray-400 hover:text-red-400 transition disabled:opacity-50"
            >
              <Ban className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() => void createKey()}
          className="flex items-center gap-2 rounded-md bg-[#353535] px-3 py-2 text-sm text-gray-200 hover:text-white hover:bg-[#404040] transition disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {live.length > 0 ? "Create a new key" : "Create email-sync key"}
        </button>
      </div>

      {/* Mode */}
      {s && (
        <div className="rounded-lg border border-charcoal-dark p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-200">Mode</span>
            <div className="flex rounded-lg border border-charcoal-dark overflow-hidden text-xs">
              {(["shadow", "live"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={busy || s.mode === m}
                  onClick={() => void switchMode(m)}
                  className={`px-3 py-1.5 transition ${
                    s.mode === m ? "bg-[#50C878]/20 text-[#50C878]" : "text-gray-300 hover:bg-[#2f2f2f]"
                  }`}
                >
                  {m === "shadow" ? "Shadow" : "Live"}
                </button>
              ))}
            </div>
          </div>
          <p className="text-xs text-gray-500">
            {s.mode === "shadow"
              ? "Shadow: alerts are read and checked, but nothing is added. Compare the shadow report with what you log by hand."
              : "Live: alerts create transactions, and purchases you also log by hand are matched instead of doubled."}
          </p>
        </div>
      )}

      {/* Counts + links */}
      {status && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
          {Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => (
              <span key={k}>
                {statusLabel(k)} <span className="text-gray-200">{n}</span>
              </span>
            ))}
        </div>
      )}
      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/settings/email-sync" className="text-[#50C878] hover:brightness-110">
          Email activity{attention > 0 ? ` (${attention} need a look)` : ""}
        </Link>
        <Link href="/categorize" className="text-[#50C878] hover:brightness-110">
          To categorize{status && status.toCategorize > 0 ? ` (${status.toCategorize})` : ""}
        </Link>
        <Link href="/rules" className="text-[#50C878] hover:brightness-110">
          Merchant rules
        </Link>
      </div>

      {/* D6 */}
      {s && (
        <div className="pt-1 border-t border-charcoal-dark">
          <label htmlFor="internal-names" className="block text-xs text-gray-400 mt-3 mb-1.5">
            Venmo names that mean &quot;us&quot; — payments between you are ignored (comma-separated)
          </label>
          <div className="flex gap-2 flex-wrap">
            <input
              id="internal-names"
              value={names}
              onChange={(e) => setNames(e.target.value)}
              placeholder="Sam Lee, Jordan Lee"
              className="flex-1 min-w-[12rem] rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-[#50C878]"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void patch({
                  internalCounterparties: names
                    .split(",")
                    .map((n) => n.trim())
                    .filter(Boolean),
                })
              }
              className="shrink-0 rounded-md bg-[#353535] px-3 py-2 text-sm text-gray-200 hover:text-white hover:bg-[#404040] transition disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
