"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/*
 * The page half of "tap a notification → land on its screen". The service
 * worker (worker/index.ts) can't reliably navigate a backgrounded iOS Home
 * Screen app, so it tells the page where to go and the page goes there itself:
 *
 *   - the worker posts { type: NAV, url } to the window it focused;
 *   - this component also PULLS on load and on every return to the foreground,
 *     for a cold start or a page iOS reloaded while it was suspended.
 *
 * Mounted once, in Providers. Renders nothing. In `next dev` there is no
 * service worker, so `ready` never resolves and this does nothing.
 */
const NAV = "stash:navigate";
const NAV_PULL = "stash:pending-navigation";
const NAV_DONE = "stash:navigated";

/** A same-origin path — never follow anything else a message names. */
function isAppPath(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//");
}

export default function NotificationNavigator() {
  const router = useRouter();

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    let cancelled = false;

    const toWorker = (message: unknown) => {
      container.ready
        .then((reg) => {
          if (!cancelled) reg.active?.postMessage(message);
        })
        .catch(() => {});
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (!data || data.type !== NAV || !isAppPath(data.url)) return;
      const here = window.location.pathname + window.location.search + window.location.hash;
      if (here !== data.url) router.push(data.url);
      toWorker({ type: NAV_DONE });
    };

    const pull = () => {
      if (document.visibilityState === "visible") toWorker({ type: NAV_PULL });
    };

    container.addEventListener("message", onMessage);
    // addEventListener (unlike onmessage) doesn't start the queue by itself.
    container.startMessages?.();
    document.addEventListener("visibilitychange", pull);
    pull();

    return () => {
      cancelled = true;
      container.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", pull);
    };
  }, [router]);

  return null;
}
