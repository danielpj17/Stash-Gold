"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Loader2, Mail } from "lucide-react";

const ERROR_MESSAGES: Record<string, string> = {
  Verification: "That sign-in link has expired or was already used. Request a new one.",
  EmailSignin: "Couldn't send the sign-in email. Check the address and try again.",
  Configuration: "Sign-in isn't configured correctly on the server.",
};

function SignInForm() {
  const params = useSearchParams();
  const callbackUrl = params.get("callbackUrl") ?? "/";
  const errorCode = params.get("error");

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    setStatus("sending");
    setError("");
    try {
      // redirect: false so a mail failure surfaces here instead of bouncing to
      // an error page with no context.
      const result = await signIn("nodemailer", { email: trimmed, callbackUrl, redirect: false });
      if (result?.error) {
        setStatus("error");
        setError(ERROR_MESSAGES[result.error] ?? "Couldn't send the sign-in email.");
        return;
      }
      window.location.href = "/signin/check-email";
    } catch {
      setStatus("error");
      setError("Couldn't send the sign-in email. Try again.");
    }
  }

  const message = error || (errorCode ? ERROR_MESSAGES[errorCode] ?? "Sign-in failed." : "");

  return (
    <div className="w-full max-w-sm rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
      <div className="px-5 py-4 bg-[#353535] border-b border-charcoal-dark">
        <h1 className="text-white text-lg font-semibold">Sign in to Stash</h1>
        <p className="text-gray-400 text-sm mt-1">
          We&apos;ll email you a link — no password to remember.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm text-gray-300 mb-1.5">
            Email address
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus:border-[#50C878]"
          />
        </div>

        {message && <p className="text-red-400 text-sm">{message}</p>}

        <button
          type="submit"
          disabled={status === "sending" || !email.trim()}
          className="w-full flex items-center justify-center gap-2 rounded-md bg-[#50C878] px-4 py-2 font-semibold text-charcoal disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 transition"
        >
          {status === "sending" ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Sending…
            </>
          ) : (
            <>
              <Mail className="w-4 h-4" />
              Email me a sign-in link
            </>
          )}
        </button>

        <p className="text-xs text-gray-500">
          New here? Entering your email creates an account — you&apos;ll start with a blank slate.
        </p>
      </form>
    </div>
  );
}

export default function SignInPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-charcoal p-4">
      {/* useSearchParams needs a Suspense boundary during prerender. */}
      <Suspense fallback={null}>
        <SignInForm />
      </Suspense>
    </main>
  );
}
