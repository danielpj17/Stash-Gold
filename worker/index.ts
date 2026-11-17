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
    openWindow(url: string): Promise<WindowClientLike | null>;
  };
  location: { origin: string };
  addEventListener(type: "push", listener: (event: PushEventLike) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationClickLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
};

type MessageEventLike = {
  data: unknown;
  source: { postMessage(message: unknown): void } | null;
  waitUntil?(promise: Promise<unknown>): void;
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
 * page navigates ITSELF — components/NotificationNavigator.tsx — told three
 * ways, because on iOS no single one is reliable for a backgrounded app:
 *
 *   1. push: focus the open window(s) and postMessage the path;
 *   2. record: write it to Cache Storage (NAV_CACHE), which the page reads
 *      DIRECTLY — no message, no worker needed. This is what survives iOS
 *      stopping the worker (in-memory state is lost) and a message that never
 *      reaches a page that is only just waking up;
 *   3. pull: the page asks on load and whenever it comes back to the
 *      foreground.
 *
 * iOS can wake the page BEFORE it runs this handler, so the page re-checks for
 * a few seconds after each return to the foreground rather than once — a
 * single check could run before anything was pending, which is how a
 * backgrounded app stayed where it was.
 *
 * NAV_CACHE holds one short-lived path, not a response: it is unrelated to
 * `runtimeCaching: []`, and sign-out's Cache Storage purge clears it too.
 * The page acks with NAV_DONE (and deletes the record itself), so a later
 * foreground can't replay an old tap; entries also expire after a minute.
 */
const NAV = "stash:navigate";
const NAV_PULL = "stash:pending-navigation";
const NAV_DONE = "stash:navigated";
const NAV_CACHE = "stash-nav";
const NAV_KEY = "/__stash/pending-navigation";
const PENDING_TTL_MS = 60_000;

type PendingNav = { id: string; url: string; at: number };

let pendingNav: PendingNav | null = null;
let pendingSettled: (() => void) | null = null;

function isFresh(p: PendingNav | null): p is PendingNav {
  return !!p && typeof p.url === "string" && p.url.startsWith("/") && Date.now() - p.at < PENDING_TTL_MS;
}

async function recordPendingNav(p: PendingNav): Promise<void> {
  try {
    const cache = await caches.open(NAV_CACHE);
    await cache.put(NAV_KEY, new Response(JSON.stringify(p), { headers: { "Content-Type": "application/json" } }));
  } catch {
    // The in-memory copy and the messages still work.
  }
}

async function readPendingNav(): Promise<PendingNav | null> {
  if (pendingNav) return pendingNav;
  try {
    const res = await caches.match(NAV_KEY, { cacheName: NAV_CACHE });
    return res ? ((await res.json()) as PendingNav) : null;
  } catch {
    return null;
  }
}

async function clearPendingNav(): Promise<void> {
  pendingNav = null;
  try {
    await caches.delete(NAV_CACHE);
  } catch {
    // Expires anyway.
  }
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
  const nav: PendingNav = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    url: target.pathname + target.search + target.hash,
    at: Date.now(),
  };
  pendingNav = nav;
  // Not awaited first: focus() should run while the tap is still fresh.
  const recorded = recordPendingNav(nav);
  event.waitUntil(
    (async () => {
      try {
        const windows = (await sw.clients.matchAll({ type: "window", includeUncontrolled: true })).filter((w) =>
          w.url.startsWith(sw.location.origin),
        );
        if (windows.length > 0) {
          try {
            await windows[0].focus();
          } catch {
            // Focus can be refused; the message and the record still land.
          }
          // Every window: on iOS the one that comes forward isn't always first.
          for (const w of windows) w.postMessage({ type: NAV, ...nav });
        } else {
          const opened = await sw.clients.openWindow(target.href);
          opened?.postMessage({ type: NAV, ...nav });
        }
      } catch {
        // Fall through: the page reads the record / pulls when it shows.
      }
      await recorded;
      await untilHandled(15_000);
    })(),
  );
});

sw.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown; id?: unknown } | null;
  if (!data || typeof data !== "object") return; // not ours (next-pwa posts its own)
  if (data.type === NAV_PULL) {
    const reply = readPendingNav().then((p) => {
      if (isFresh(p)) event.source?.postMessage({ type: NAV, ...p });
    });
    event.waitUntil?.(reply);
  } else if (data.type === NAV_DONE) {
    // Only the tap that was handled — a newer one may be on its way.
    if (!pendingNav || data.id === undefined || data.id === pendingNav.id) {
      event.waitUntil?.(clearPendingNav());
      pendingSettled?.();
    }
  }
});

export {};
