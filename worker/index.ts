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
  navigate?(url: string): Promise<unknown>;
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

/** Focus an open Stash window and navigate it, or open one. */
sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/categorize", sw.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((w) => w.url.startsWith(sw.location.origin));
      if (existing) {
        await existing.focus();
        if (existing.navigate) await existing.navigate(target);
        return;
      }
      await sw.clients.openWindow(target);
    })(),
  );
});

export {};
