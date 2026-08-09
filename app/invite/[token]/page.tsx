"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Loader2, Users } from "lucide-react";

/**
 * Accept an invitation to share someone's Stash.
 *
 * Anonymous visitors never reach this component: middleware bounces them to
 * /signin with this URL as the callback, so by the time it renders there is a
 * session — just possibly the wrong one, which the server reports as a 403
 * naming the address the invitation was actually sent to.
 *
 * The name field is optional and only affects display. Skipping it means
 * transactions render exactly as they do today, with no name after the date,
 * which is a perfectly fine end state.
 */
export default function InvitePage({ params }: { params: { token: string } }) {
  const token = params.token;

  const [state, setState] = useState<"loading" | "ready" | "error" | "done">("loading");
  const [inviterLabel, setInviterLabel] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/household/accept?token=${encodeURIComponent(token)}`, {
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(data?.error ?? "This invitation can't be used.");
          setState("error");
          return;
        }
        setInviterLabel(data.inviterLabel ?? "Someone");
        setState("ready");
      } catch {
        if (!cancelled) {
          setError("Couldn't reach the server. Try again.");
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAccept = useCallback(async () => {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/household/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: name.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Couldn't accept the invitation.");
      setState("done");
      // Full navigation rather than router.push: every context caches by user
      // id, and the data scope has just changed underneath them.
      setTimeout(() => {
        window.location.href = "/";
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't accept the invitation.");
      setSubmitting(false);
    }
  }, [token, name]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-charcoal p-4">
      <div className="w-full max-w-sm rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
        <div className="px-5 py-4 bg-[#353535] border-b border-charcoal-dark flex items-center gap-3">
          <Users className="w-5 h-5 text-[#50C878] shrink-0" />
          <h1 className="text-white text-lg font-semibold">Shared Stash</h1>
        </div>

        <div className="p-5 space-y-4">
          {state === "loading" && (
            <p className="text-gray-400 text-sm flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Checking your invitation…
            </p>
          )}

          {state === "error" && (
            <>
              <p className="text-red-400 text-sm">{error}</p>
              <Link
                href="/"
                className="inline-block text-sm text-[#50C878] underline hover:brightness-110"
              >
                Go to Stash
              </Link>
            </>
          )}

          {state === "ready" && (
            <>
              <p className="text-gray-300 text-sm leading-relaxed">
                <strong className="text-white">{inviterLabel}</strong> invited you to share their
                budget. You&apos;ll see the same accounts, transactions and budget they do, and
                anything you add is labelled with your name.
              </p>

              <div>
                <label htmlFor="name" className="block text-sm text-gray-300 mb-1.5">
                  Your name <span className="text-gray-500">(optional)</span>
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Sarah"
                  className="w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus:border-[#50C878]"
                />
                <p className="text-xs text-gray-500 mt-1.5">
                  Shown next to transactions you enter, so you can tell them apart.
                </p>
              </div>

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <button
                type="button"
                onClick={() => void handleAccept()}
                disabled={submitting}
                className="w-full flex items-center justify-center gap-2 rounded-md bg-[#50C878] px-4 py-2 font-semibold text-charcoal disabled:opacity-50 hover:brightness-110 transition"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {submitting ? "Joining…" : "Join"}
              </button>
            </>
          )}

          {state === "done" && (
            <p className="text-sm text-white flex items-center gap-2">
              <Check className="w-4 h-4 text-[#50C878]" />
              You&apos;re in — opening Stash…
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
