/**
 * Custom service-worker code (plan §5.9). @ducanh2912/next-pwa compiles this
 * to public/worker-<hash>.js and importScripts() it from the generated sw.js.
 * NEVER hand-edit public/sw.js — it is regenerated on every build — and leave
 * `runtimeCaching: []` in next.config.js alone.
 *
 * There is no service worker in `next dev` (next-pwa is disabled there), so
 * this can only be exercised on a deployed build — on iPhone, from the Home
 * Screen app.
 *
 * Types are declared locally: the app's tsconfig uses the DOM lib, which has
 * no ServiceWorkerGlobalScope.
 */

type PushPayload = { title?: string; body?: string; tag?: string; url?: string };

type WindowClientLike = {
  url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
};

type ServiceWorkerScope = {
  registration: {
    showNotification(title: string, options: Record<string, unknown>): Promise<void>;
  };
  clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  location: { origin: string };
  addEventListener(type: "push", listener: (event: PushEventLike) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationClickLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
};

type MessageEventLike = {
  data: unknown;
  source: { postMessage(message: unknown): void } | null;
};

type PushEventLike = {
  data: { json(): unknown; text(): string } | null;
  waitUntil(promise: Promise<unknown>): void;
};

type NotificationClickLike = {
  notification: { close(): void; data?: { url?: string } };
  waitUntil(promise: Promise<unknown>): void;
};

const sw = self as unknown as ServiceWorkerScope;

function readPayload(event: PushEventLike): PushPayload {
  if (!event.data) return {};
  try {
    return event.data.json() as PushPayload;
  } catch {
    return { body: event.data.text() };
  }
}

/**
 * ALWAYS show a notification. iOS revokes a subscription that receives pushes
 * without a visible notification, so there are no silent or data-only pushes.
 * `tag` = the transaction id, so a repeat replaces rather than stacks.
 */
sw.addEventListener("push", (event) => {
  const payload = readPayload(event);
  event.waitUntil(
    sw.registration.showNotification(payload.title || "Stash", {
      body: payload.body || "You have a purchase to categorize.",
      tag: payload.tag || "stash",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url || "/categorize" },
    }),
  );
});

/*
 * Tapping a notification must land on ITS screen (/categorize/<id>), whether
 * Stash was closed, backgrounded, or open on another page.
 *
 * WindowClient.navigate() can't be relied on for that: iOS brings the
 * backgrounded Home Screen app forward and silently leaves it on whatever page
 * it was showing (it also rejects for a client the SW doesn't control). So the
 * page navigates ITSELF — components/NotificationNavigator.tsx — told two ways:
 *
 *   1. push: focus the open window and postMessage it the path;
 *   2. pull: the page asks on load and whenever it becomes visible, which
 *      covers a cold start (iOS may open start_url instead of the URL given to
 *      openWindow) and a page iOS reloaded while it was suspended.
 *
 * The page acks with NAV_DONE, which clears the pending path, so a later
 * foreground can't replay an old tap.
 */
const NAV = "stash:navigate";
const NAV_PULL = "stash:pending-navigation";
const NAV_DONE = "stash:navigated";
const PENDING_TTL_MS = 60_000;

let pendingNav: { url: string; at: number } | null = null;
let pendingSettled: (() => void) | null = null;

function takePendingNav(): string | null {
  const p = pendingNav;
  pendingNav = null;
  return p && Date.now() - p.at < PENDING_TTL_MS ? p.url : null;
}

/** Keep the worker (and `pendingNav`) alive until the page acks, or give up. */
function untilHandled(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSettled = null;
      resolve();
    }, ms);
    pendingSettled = () => {
      clearTimeout(timer);
      pendingSettled = null;
      resolve();
    };
  });
}

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/categorize", sw.location.origin);
  const path = target.pathname + target.search + target.hash;
  pendingNav = { url: path, at: Date.now() };
  event.waitUntil(
    (async () => {
      try {
        const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
        const existing = windows.find((w) => w.url.startsWith(sw.location.origin));
        if (existing) {
          try {
            await existing.focus();
          } catch {
            // Focus can be refused; the message below still lands when it's shown.
          }
          existing.postMessage({ type: NAV, url: path });
        } else {
          await sw.clients.openWindow(target.href);
        }
      } catch {
        // Fall through: the page pulls `pendingNav` when it loads.
      }
      await untilHandled(15_000);
    })(),
  );
});

sw.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown } | null;
  if (!data || typeof data !== "object") return; // not ours (next-pwa posts its own)
  if (data.type === NAV_PULL) {
    const url = takePendingNav();
    if (url) event.source?.postMessage({ type: NAV, url });
  } else if (data.type === NAV_DONE) {
    pendingNav = null;
    pendingSettled?.();
  }
});

export {};
