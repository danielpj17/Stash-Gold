import { NextResponse, type NextRequest } from "next/server";

/**
 * Cookie-presence gate. This is UX, not security.
 *
 * In Next 14.2 middleware is Edge-only (the Node runtime option landed in
 * 15.2), and with database sessions a real check needs a DB read. So middleware
 * only asks "is there a session cookie?" and bounces anonymous traffic early.
 * A forged cookie sails past here and then hits `requireUser()` inside a Node
 * route handler, which does the actual lookup and returns 401.
 */
const SESSION_COOKIES = [
  "authjs.session-token", // v5 name (v4 used next-auth.session-token)
  "__Secure-authjs.session-token",
];

const PUBLIC_PREFIXES = [
  "/signin",
  "/api/auth",
  "/api/ingest", // bearer-token only; carries no cookie
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }
  if (SESSION_COOKIES.some((name) => req.cookies.has(name))) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/signin";
  url.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

/**
 * PWA assets MUST stay public. If sw.js, the workbox bundles, or the manifest
 * ever 302 to /signin, the service worker silently fails to register and the
 * installed app breaks.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.svg|icons/|manifest|sw\\.js|workbox-|swe-worker-).*)",
  ],
};
