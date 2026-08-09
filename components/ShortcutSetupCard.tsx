"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Check, Loader2, Plus, Ban, Smartphone, ChevronDown } from "lucide-react";

type TokenSummary = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

function fmtDate(value: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "unknown"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          // Clipboard blocked (insecure context / permissions) — the value is
          // selectable on screen, so this is a convenience, not the only path.
        }
      }}
      aria-label={label}
      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-[#353535] text-gray-200 hover:text-white hover:bg-[#404040] transition"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-[#50C878]" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Inline "copy link" affordance for prose. */
function CopyLink({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          /* clipboard unavailable; the link is still visible above */
        }
      }}
      className="underline text-[#50C878] hover:brightness-110"
    >
      {copied ? "link copied" : "copy the link"}
    </button>
  );
}

/**
 * iOS Shortcut setup, collapsed by default.
 *
 * This sits under the New Expense form because that is the same job done a
 * different way — but it is a once-per-phone task, so it stays out of the way
 * until asked for. Tokens are fetched on first expand rather than on mount:
 * New Expense is the app's hot path and shouldn't pay for a panel nobody
 * opened.
 */
export default function ShortcutSetupCard() {
  const [open, setOpen] = useState(false);
  /** Null until the panel is first opened — see the lazy-load note above. */
  const [tokens, setTokens] = useState<TokenSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  /** Held in memory only — the server never returns a raw token again. */
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tokens", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load tokens (${res.status})`);
      const data = (await res.json()) as { tokens?: TokenSummary[] };
      setTokens(Array.isArray(data.tokens) ? data.tokens : []);
      setError("");
    } catch (err) {
      setTokens((prev) => prev ?? []);
      setError(err instanceof Error ? err.message : "Failed to load tokens");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && tokens === null && !loading) void load();
  }, [open, tokens, loading, load]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "iOS Shortcut" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Failed to create token (${res.status})`);
      setFreshToken(data.rawToken ?? null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  }, [load]);

  const handleRevoke = useCallback(
    async (token: TokenSummary) => {
      if (!window.confirm(`Revoke "${token.name}" (${token.prefix}…)? Any Shortcut using it stops working.`)) {
        return;
      }
      try {
        const res = await fetch("/api/tokens", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: token.id }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error ?? `Failed to revoke (${res.status})`);
        }
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to revoke token");
      }
    },
    [load],
  );

  /** Revokes every token except the one on screen. See `otherActive` below. */
  const handleRevokeOthers = useCallback(
    async (targets: TokenSummary[]) => {
      const plural = targets.length === 1 ? "token" : "tokens";
      if (!window.confirm(`Revoke ${targets.length} older ${plural}? Any Shortcut using them stops working.`)) {
        return;
      }
      try {
        for (const target of targets) {
          const res = await fetch("/api/tokens", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: target.id }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data?.error ?? `Failed to revoke (${res.status})`);
          }
        }
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to revoke tokens");
      }
    },
    [load],
  );

  /**
   * A pre-built Shortcut shared as an iCloud link. It prompts for the token on
   * install (an Import Question), so one link works for everyone — each person
   * supplies their own.
   *
   * iOS requires shortcuts to be signed (macOS-only `shortcuts sign`) and Apple
   * has no API for minting iCloud links, so this URL can't be generated per
   * user at runtime. It's authored once by hand and set as an env var. When
   * it's unset there is nothing to install, so the panel says so.
   */
  const shortcutUrl = (process.env.NEXT_PUBLIC_SHORTCUT_ICLOUD_URL ?? "").trim();
  const tokenList = tokens ?? [];
  const activeToken = tokenList.find((t) => !t.revokedAt) ?? null;
  /**
   * Only the token in play is shown. Older ones are still on the server (the
   * DELETE route revokes rather than deletes, so the audit trail survives), but
   * a growing list of dead prefixes is noise on a page whose whole job is "one
   * token per phone". `tokens` is ordered newest-first by the API, so falling
   * back to `[0]` surfaces the most recent revoked token when nothing is live —
   * enough to explain why the Shortcut stopped working.
   */
  const currentToken = activeToken ?? tokenList[0] ?? null;
  /**
   * Hiding the history must not hide a *live* credential — an older token that
   * still works but has no row on screen could never be revoked from the UI.
   * These get one summary line instead of their own entries.
   */
  const otherActive = tokenList.filter((t) => !t.revokedAt && t.id !== currentToken?.id);

  return (
    <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="shortcut-setup-panel"
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#2c2c2c] transition-colors"
      >
        <Smartphone className="w-4 h-4 shrink-0 text-[#50C878]" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-white font-medium">iOS Shortcut</span>
          <span className="block text-xs text-gray-400 truncate">
            Log an expense from your phone without opening the app.
          </span>
        </span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div id="shortcut-setup-panel" className="border-t border-charcoal-dark p-4 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs text-gray-400">
              One token per phone. Create it here, paste it into the Shortcut once.
            </p>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating}
              className="shrink-0 flex items-center gap-2 rounded-md bg-[#50C878] px-3 py-1.5 text-sm font-semibold text-charcoal disabled:opacity-50 hover:brightness-110 transition"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              New token
            </button>
          </div>

          {freshToken && (
            <div className="rounded-lg border border-[#50C878]/40 bg-[#50C878]/10 p-3 space-y-2">
              <p className="text-sm text-white font-medium">
                Copy this token now — it won&apos;t be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 break-all rounded bg-[#1f1f1f] px-2 py-1.5 text-xs text-[#50C878]">
                  {freshToken}
                </code>
                <CopyButton text={freshToken} label="Copy token" />
              </div>
              <button
                type="button"
                onClick={() => setFreshToken(null)}
                className="text-xs text-gray-400 hover:text-white"
              >
                I&apos;ve saved it — hide
              </button>
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          {loading && tokens === null ? (
            <p className="text-sm text-gray-400">Loading tokens…</p>
          ) : !currentToken ? (
            <p className="text-sm text-gray-400">
              No token yet. Create one, then paste it into your Shortcut when it asks.
            </p>
          ) : (
            <div
              className={`px-3 py-2.5 rounded-lg border border-charcoal-dark flex items-center gap-3 flex-wrap ${
                currentToken.revokedAt ? "opacity-50" : ""
              }`}
            >
              <code className="text-xs text-gray-300">{currentToken.prefix}…</code>
              <span className="text-sm text-gray-300">{currentToken.name}</span>
              <span className="text-xs text-gray-500">
                created {fmtDate(currentToken.createdAt)} · last used {fmtDate(currentToken.lastUsedAt)}
              </span>
              {currentToken.revokedAt ? (
                <span className="ml-auto text-xs text-red-400">revoked</span>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleRevoke(currentToken)}
                  className="ml-auto flex items-center gap-1 text-xs text-gray-400 hover:text-red-400 transition"
                >
                  <Ban className="w-3.5 h-3.5" />
                  Revoke
                </button>
              )}
            </div>
          )}

          {otherActive.length > 0 && (
            <p className="text-xs text-gray-500">
              {otherActive.length} older {otherActive.length === 1 ? "token is" : "tokens are"} still
              active.{" "}
              <button
                type="button"
                onClick={() => void handleRevokeOthers(otherActive)}
                className="underline text-gray-400 hover:text-red-400 transition"
              >
                Revoke {otherActive.length === 1 ? "it" : "them"}
              </button>
            </p>
          )}

          {shortcutUrl && (
            <div className="rounded-lg border border-[#50C878]/40 bg-[#50C878]/5 overflow-hidden">
              <div className="px-3 py-2 bg-[#50C878]/10">
                <h3 className="text-sm text-white font-medium">Add it to your iPhone</h3>
              </div>
              <div className="p-3 space-y-3 text-sm text-gray-300">
                <ol className="space-y-2">
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-[#50C878] text-charcoal text-xs font-bold flex items-center justify-center">
                      1
                    </span>
                    <span>
                      {activeToken ? (
                        <>
                          Copy your token
                          {freshToken ? " from the green box above." : "."}
                          {!freshToken && (
                            <span className="block text-xs text-gray-500 mt-0.5">
                              Tokens are only shown once, so if you didn&apos;t save it, create a
                              new one above and revoke the old one.
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          Create a token with <strong>New token</strong> above, and copy it.
                        </>
                      )}
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-[#50C878] text-charcoal text-xs font-bold flex items-center justify-center">
                      2
                    </span>
                    <span>
                      Open this link on your iPhone and tap <strong>Add Shortcut</strong>. It
                      will ask for your token — paste it in.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-[#50C878] text-charcoal text-xs font-bold flex items-center justify-center">
                      3
                    </span>
                    <span>
                      Put it somewhere you can reach in one tap: press and hold it in the Shortcuts
                      app and choose <strong>Share → Add to Home Screen</strong>, or add the{" "}
                      <strong>Shortcuts</strong> control under{" "}
                      <strong>Settings → Control Center</strong>.
                    </span>
                  </li>
                </ol>

                <a
                  href={shortcutUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-md bg-[#50C878] px-4 py-2 font-semibold text-charcoal hover:brightness-110 transition"
                >
                  <Smartphone className="w-4 h-4" />
                  Add to iPhone
                </a>

                <p className="text-xs text-gray-500">
                  Reading this on a computer? Send the link to your phone —{" "}
                  <CopyLink text={shortcutUrl} />
                </p>
              </div>
            </div>
          )}

          {!shortcutUrl && (
            <p className="text-xs text-gray-500 rounded-lg border border-charcoal-dark p-3">
              <strong className="text-gray-400">Running this app?</strong> Build the Shortcut once
              with an Import Question for the token, share it as an iCloud link, and set{" "}
              <code className="text-gray-400">NEXT_PUBLIC_SHORTCUT_ICLOUD_URL</code> to that link.
              An &quot;Add to iPhone&quot; button then appears here for everyone. See{" "}
              <code className="text-gray-400">docs/ios-shortcut-setup.md</code>.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
