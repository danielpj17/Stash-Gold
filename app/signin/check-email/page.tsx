"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { SIGN_IN_CODE_LENGTH, normalizeSignInCode } from "@/lib/signInCode";

function CodeForm() {
  const params = useSearchParams();
  const email = params.get("email") ?? "";
  const callbackUrl = params.get("callbackUrl") ?? "/";

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const normalized = normalizeSignInCode(code);
  const complete = normalized.length === SIGN_IN_CODE_LENGTH;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!complete) return;
    if (!email) {
      setError("We lost track of which email this was for. Request a new code.");
      return;
    }
    setSubmitting(true);
    setError("");

    // A full page navigation, not fetch: the callback sets the session cookie
    // and redirects, and both need to happen at the top level. Doing it from
    // inside the installed app is the whole point — the cookie lands in the
    // app's jar rather than Safari's.
    const target =
      `/api/auth/callback/nodemailer` +
      `?token=${encodeURIComponent(normalized)}` +
      `&email=${encodeURIComponent(email)}` +
      `&callbackUrl=${encodeURIComponent(callbackUrl)}`;
    window.location.assign(target);
  }

  return (
    <div className="w-full max-w-sm rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
      <div className="px-5 py-4 bg-[#353535] border-b border-charcoal-dark">
        <h1 className="text-white text-lg font-semibold">Check your email</h1>
        <p className="text-gray-400 text-sm mt-1">
          {email ? (
            <>
              We sent a code to <span className="text-gray-200">{email}</span>.
            </>
          ) : (
            <>We sent you a sign-in code.</>
          )}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        <div>
          <label htmlFor="code" className="block text-sm text-gray-300 mb-1.5">
            Enter your sign-in code
          </label>
          <input
            id="code"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="K7M2-9XQP"
            className="w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-2.5 text-white text-center text-lg tracking-[0.2em] font-mono uppercase placeholder:text-gray-600 placeholder:tracking-[0.2em] focus:outline-none focus:border-[#50C878]"
          />
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={!complete || submitting}
          className="w-full flex items-center justify-center gap-2 rounded-md bg-[#50C878] px-4 py-2 font-semibold text-charcoal disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 transition"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Sign in
        </button>

        <div className="border-t border-charcoal-dark pt-4 space-y-2">
          <p className="text-xs text-gray-400">
            <strong className="text-gray-300">Added Stash to your home screen?</strong> Use the
            code. Tapping the link in the email opens Safari, which signs you in there but not in
            the app — iOS keeps them separate.
          </p>
          <p className="text-xs text-gray-500">
            In a normal browser tab you can just tap the link in the email instead.
          </p>
        </div>

        <p className="text-xs text-gray-500">
          Code expires in 15 minutes and works once.{" "}
          <Link href="/signin" className="text-[#50C878] hover:brightness-110">
            Send a new one
          </Link>
        </p>
      </form>
    </div>
  );
}

export default function CheckEmailPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-charcoal p-4">
      <Suspense fallback={null}>
        <CodeForm />
      </Suspense>
    </main>
  );
}
