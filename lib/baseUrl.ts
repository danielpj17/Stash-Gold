import type { NextRequest } from "next/server";

/**
 * The absolute origin to put in a link that leaves the app — an email, mostly.
 *
 * Derived from the REQUEST, not from `AUTH_URL`. `AUTH_URL` is pinned to
 * http://localhost:3000 on purpose (see /CLAUDE.md — magic-link callbacks break
 * if the dev port drifts), so reading it here would mail every recipient a
 * link to their own machine. That was a real bug: the invite email's button
 * appeared to do nothing.
 *
 * This mirrors what Auth.js already does with `trustHost: true` in auth.ts,
 * which is why sign-in emails were unaffected. Vercel sets `x-forwarded-host`
 * and `x-forwarded-proto`; locally the plain `host` header is already correct.
 *
 * Trusting the Host header is only safe because it is used for a link we mail
 * to a user, never for an origin check or a redirect allowlist.
 */
export function absoluteBaseUrl(req: NextRequest): string {
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").trim();

  if (host) {
    const forwardedProto = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim();
    // Bare hostnames on the public internet are https; only loopback is http.
    const proto = forwardedProto || (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  }

  // Nothing to derive from (a non-HTTP invocation). AUTH_URL is a better guess
  // than nothing, and in local dev it is exactly right.
  const configured = (process.env.AUTH_URL ?? "").trim().replace(/\/+$/, "");
  return configured || req.nextUrl.origin;
}
