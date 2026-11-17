"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/*
 * The FALLBACK page half of "tap a notification → land on its screen".
 * Where the browser supports a notification's `navigate` URL (iOS/Safari
 * 18.5+, Firefox 158+) it opens the screen itself and none of this runs — and
 * on iOS that is the only thing that works for an app already running in the
 * background, whose worker never sees the tap (WebKit bug 268797). This covers
 * Chrome and older iOS, where `notificationclick` still fires.
 *
 * The service worker (worker/index.ts) can't reliably navigate a backgrounded
 * Home Screen app, so it tells the page where to go and the page goes there itself.
 * It is told three ways, and whichever arrives first wins:
 *
 *   - the worker posts { type: NAV, id, url } to the open window(s);
 *   - the worker records the same thing in Cache Storage, which this reads
 *     DIRECTLY — the path that still works when iOS stopped the worker or
 *     dropped the message to a page that was only just waking up;
 *   - this asks the worker (a pull) as well.
 *
 * It checks on load and every time the app comes back to the foreground —
 * and not just once: iOS can bring the page forward BEFORE the worker has
 * handled the tap, so a single check can run before anything is pending
 * (that is how a backgrounded app used to stay where it was). It re-checks a
 * few times over ~5s instead.
 *
 * Mounted once, in Providers. Renders nothing. In `next dev` there is no
 * service worker, so nothing is ever pending.
 */
const NAV = "stash:navigate";
const NAV_PULL = "stash:pending-navigation";
const NAV_DONE = "stash:navigated";
const NAV_CACHE = "stash-nav";
const NAV_KEY = "/__stash/pending-navigation";
const PENDING_TTL_MS = 60_000;
/** After each return to the foreground: check now, then again as the tap lands. */
const RECHECK_MS = [0, 400, 1200, 2500, 5000];

type NavLike = { type?: unknown; id?: unknown; url?: unknown; at?: unknown };

/** A same-origin path — never follow anything else a message names. */
function isAppPath(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//");
}

async function readRecorded(): Promise<NavLike | null> {
  if (typeof caches === "undefined") return null;
  try {
    // match() with cacheName never creates the cache (open() would).
    const res = await caches.match(NAV_KEY, { cacheName: NAV_CACHE });
    return res ? ((await res.json()) as NavLike) : null;
  } catch {
    return null;
  }
}

export default function NotificationNavigator() {
  const router = useRouter();

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    let cancelled = false;
    const handled = new Set<string>();
    let timers: number[] = [];

    const toWorker = (message: unknown) => {
      container.ready
        .then((reg) => {
          if (!cancelled) reg.active?.postMessage(message);
        })
        .catch(() => {});
    };

    const forget = () => {
      if (typeof caches !== "undefined") void caches.delete(NAV_CACHE).catch(() => {});
    };

    const go = (nav: NavLike | null) => {
      if (cancelled || !nav) return;
      if (!isAppPath(nav.url) || (typeof nav.at === "number" && Date.now() - nav.at > PENDING_TTL_MS)) {
        forget(); // an old or malformed record — never follow it, don't keep it
        return;
      }
      const id = typeof nav.id === "string" ? nav.id : nav.url;
      if (handled.has(id)) return; // the message AND the record both arrived
      handled.add(id);
      forget();
      toWorker({ type: NAV_DONE, id: typeof nav.id === "string" ? nav.id : undefined });
      const here = window.location.pathname + window.location.search + window.location.hash;
      if (here !== nav.url) router.push(nav.url);
    };

    const check = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      void readRecorded().then(go);
      toWorker({ type: NAV_PULL });
    };

    /** A burst of checks; a new trigger restarts it rather than stacking. */
    const recheck = () => {
      for (const t of timers) window.clearTimeout(t);
      timers = RECHECK_MS.map((ms) => window.setTimeout(check, ms));
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data as NavLike | null;
      if (data && data.type === NAV) go(data);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") recheck();
    };

    container.addEventListener("message", onMessage);
    // addEventListener (unlike onmessage) doesn't start the queue by itself.
    container.startMessages?.();
    // iOS doesn't fire the same event on every resume, so listen for all three.
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", recheck);
    window.addEventListener("focus", recheck);
    recheck();

    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
      container.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [router]);

  return null;
}
