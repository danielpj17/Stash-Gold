"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Copy, Check, Loader2, Plus, Ban } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import SignOutButton from "@/components/SignOutButton";

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

export default function SettingsPage() {
  const { data: session, status } = useSession();

  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  /** Held in memory only — the server never returns a raw token again. */
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tokens", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load tokens (${res.status})`);
      const data = (await res.json()) as { tokens?: TokenSummary[] };
      setTokens(Array.isArray(data.tokens) ? data.tokens : []);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tokens");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") void load();
  }, [status, load]);

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

  const ingestUrl = `${origin || "https://your-app.vercel.app"}/api/ingest`;
  const exampleBody = '{"expenseType":"Groceries","amount":42.50,"description":"Smiths"}';

  return (
    <DashboardLayout>
      <div className="max-w-3xl space-y-4">
        <h1 className="text-white text-xl font-semibold">Settings</h1>

        <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-semibold">Account</h2>
          </div>
          <div className="p-4 space-y-3">
            {status === "loading" ? (
              <p className="text-sm text-gray-400">Loading…</p>
            ) : (
              <p className="text-sm text-gray-300">
                Signed in as{" "}
                <span className="text-white font-semibold">{session?.user?.email ?? "unknown"}</span>
              </p>
            )}
            <p className="text-sm text-gray-400">
              Manage your{" "}
              <Link href="/settings/accounts" className="text-[#50C878] hover:brightness-110">
                bank and card accounts
              </Link>
              .
            </p>
            <div className="max-w-[12rem]">
              <SignOutButton />
            </div>
          </div>
        </section>

        <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-2">
            <div>
              <h2 className="text-white font-semibold">iOS Shortcut</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Log an expense from your phone without opening the app or signing in.
              </p>
            </div>
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

          <div className="p-4 space-y-4">
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

            {loading ? (
              <p className="text-sm text-gray-400">Loading tokens…</p>
            ) : tokens.length === 0 ? (
              <p className="text-sm text-gray-400">
                No tokens yet. Create one, then paste it into your Shortcut using the setup below.
              </p>
            ) : (
              <ul className="divide-y divide-charcoal-dark rounded-lg border border-charcoal-dark overflow-hidden">
                {tokens.map((token) => (
                  <li
                    key={token.id}
                    className={`px-3 py-2.5 flex items-center gap-3 flex-wrap ${token.revokedAt ? "opacity-50" : ""}`}
                  >
                    <code className="text-xs text-gray-300">{token.prefix}…</code>
                    <span className="text-sm text-gray-300">{token.name}</span>
                    <span className="text-xs text-gray-500">
                      created {fmtDate(token.createdAt)} · last used {fmtDate(token.lastUsedAt)}
                    </span>
                    {token.revokedAt ? (
                      <span className="ml-auto text-xs text-red-400">revoked</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleRevoke(token)}
                        className="ml-auto flex items-center gap-1 text-xs text-gray-400 hover:text-red-400 transition"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        Revoke
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="rounded-lg border border-charcoal-dark overflow-hidden">
              <div className="px-3 py-2 bg-[#2C2C2C]">
                <h3 className="text-sm text-white font-medium">Shortcut setup</h3>
              </div>
              <div className="p-3 space-y-3 text-sm text-gray-300">
                <p>
                  On your iPhone: Shortcuts → new shortcut → add a{" "}
                  <strong>Get Contents of URL</strong> action, then set:
                </p>
                <dl className="space-y-2 text-xs">
                  <div className="flex items-center gap-2">
                    <dt className="w-20 shrink-0 text-gray-500">URL</dt>
                    <dd className="flex-1 min-w-0 flex items-center gap-2">
                      <code className="flex-1 min-w-0 break-all rounded bg-[#1f1f1f] px-2 py-1.5 text-gray-200">
                        {ingestUrl}
                      </code>
                      <CopyButton text={ingestUrl} label="Copy ingest URL" />
                    </dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <dt className="w-20 shrink-0 text-gray-500">Method</dt>
                    <dd>
                      <code className="rounded bg-[#1f1f1f] px-2 py-1.5 text-gray-200">POST</code>
                    </dd>
                  </div>
                  <div className="flex items-start gap-2">
                    <dt className="w-20 shrink-0 text-gray-500 pt-1.5">Headers</dt>
                    <dd className="flex-1 min-w-0">
                      <code className="block rounded bg-[#1f1f1f] px-2 py-1.5 text-gray-200 break-all">
                        Authorization: Bearer &lt;your token&gt;
                        <br />
                        Content-Type: application/json
                      </code>
                    </dd>
                  </div>
                  <div className="flex items-start gap-2">
                    <dt className="w-20 shrink-0 text-gray-500 pt-1.5">Body</dt>
                    <dd className="flex-1 min-w-0 flex items-center gap-2">
                      <code className="flex-1 min-w-0 break-all rounded bg-[#1f1f1f] px-2 py-1.5 text-gray-200">
                        {exampleBody}
                      </code>
                      <CopyButton text={exampleBody} label="Copy example body" />
                    </dd>
                  </div>
                </dl>
                <p className="text-xs text-gray-500">
                  Use <strong>Ask Each Time</strong> for the amount and description so the Shortcut
                  prompts you when it runs. Add <code>&quot;account&quot;</code> with an account id
                  to make it affect a specific balance, or{" "}
                  <code>&quot;date&quot;: &quot;2026-03-14&quot;</code> to back-date it. If you
                  ever lose your phone, revoke the token above — no redeploy needed.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}
