"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Loader2, Send } from "lucide-react";

type Prefs = { accounts: Array<{ id: string; name: string; enabled: boolean }> };
type SubInfo = { configured: boolean; publicKey: string | null; subscriptions: Array<{ id: string; deviceLabel: string | null }> };

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Browser";
}

/**
 * Settings → Notifications (plan §5.9). Everything here is PER PERSON: the
 * devices and the per-account toggles belong to whoever is signed in. Only the
 * answer timeout is shared.
 *
 * On iOS a denied permission is near-permanent (recovery means deleting and
 * re-adding the Home Screen app), so an explainer comes BEFORE the system
 * prompt, and the prompt is only ever shown from a tap.
 */
export default function NotificationsPanel() {
  const [support, setSupport] = useState<{ supported: boolean; installed: boolean; permission: string }>({
    supported: false,
    installed: false,
    permission: "default",
  });
  const [subInfo, setSubInfo] = useState<SubInfo | null>(null);
  const [thisDevice, setThisDevice] = useState<PushSubscription | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [timeout, setTimeoutHours] = useState<number | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const supported =
      typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    const installed =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(display-mode: standalone)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true);
    setSupport({ supported, installed, permission: supported ? Notification.permission : "unsupported" });

    try {
      const [s, p, e] = await Promise.all([
        fetch("/api/push/subscriptions", { cache: "no-store" }),
        fetch("/api/notifications/prefs", { cache: "no-store" }),
        fetch("/api/email-sync", { cache: "no-store" }),
      ]);
      if (s.ok) setSubInfo((await s.json()) as SubInfo);
      if (p.ok) setPrefs((await p.json()) as Prefs);
      if (e.ok) setTimeoutHours(((await e.json()) as { settings: { answerTimeoutHours: number } }).settings.answerTimeoutHours);
    } catch {
      /* show what we have */
    }

    if (supported) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        setThisDevice(reg ? await reg.pushManager.getSubscription() : null);
      } catch {
        setThisDevice(null);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      if (!subInfo?.publicKey) throw new Error("Push isn't configured on the server yet.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setExplaining(false);
        await refresh();
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(subInfo.publicKey) as BufferSource,
        }));
      const res = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), deviceLabel: deviceLabel() }),
      });
      if (!res.ok) throw new Error("Couldn't register this device");
      setExplaining(false);
      setMessage("Notifications are on for this device.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't turn on notifications");
    } finally {
      setBusy(false);
    }
  }, [refresh, subInfo]);

  const disableHere = useCallback(async () => {
    setBusy(true);
    try {
      if (thisDevice) {
        await fetch("/api/push/subscriptions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: thisDevice.endpoint }),
        });
        await thisDevice.unsubscribe();
      }
      setMessage("This device won't get notifications.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh, thisDevice]);

  const sendTest = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      setMessage(
        data.devices === 0 ? "No devices registered yet." : `Sent to ${data.sent} of ${data.devices} device(s).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const toggle = useCallback(async (accountId: string, enabled: boolean) => {
    setPrefs((prev) =>
      prev ? { accounts: prev.accounts.map((a) => (a.id === accountId ? { ...a, enabled } : a)) } : prev,
    );
    const res = await fetch("/api/notifications/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, enabled }),
    });
    if (!res.ok) {
      setError("Couldn't save that preference");
      await refresh();
    }
  }, [refresh]);

  const saveTimeout = useCallback(async (hours: number) => {
    setTimeoutHours(hours);
    await fetch("/api/email-sync", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answerTimeoutHours: hours }),
    });
  }, []);

  const denied = support.permission === "denied";
  const enabledHere = support.permission === "granted" && thisDevice !== null;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-400">{error}</p>}
      {message && <p className="text-sm text-[#50C878]">{message}</p>}

      <div className="rounded-lg border border-charcoal-dark px-3 py-2.5 text-xs text-gray-400 space-y-0.5">
        <p>
          This device:{" "}
          <span className="text-gray-200">
            {!support.supported
              ? "notifications not supported here"
              : enabledHere
                ? "on"
                : denied
                  ? "blocked"
                  : "off"}
          </span>
          {support.supported && !support.installed && " · not installed to the Home Screen"}
        </p>
        {subInfo && !subInfo.configured && <p className="text-yellow-200">Push isn&apos;t configured on the server yet.</p>}
        {subInfo && subInfo.subscriptions.length > 0 && (
          <p>
            Your devices: {subInfo.subscriptions.map((s) => s.deviceLabel ?? "device").join(", ")}
          </p>
        )}
      </div>

      {denied && (
        <div className="rounded-lg border border-yellow-400/40 bg-yellow-400/10 p-3 text-xs text-yellow-100 space-y-1">
          <p className="font-medium">Notifications are blocked for Stash on this device.</p>
          <p>
            On iPhone: delete the Stash icon from your Home Screen, open Stash in Safari, Share → Add to Home Screen,
            then turn notifications on here again. Elsewhere: allow notifications for this site in the browser&apos;s
            site settings.
          </p>
        </div>
      )}

      {support.supported && !denied && !enabledHere && !explaining && (
        <button
          type="button"
          disabled={busy || !subInfo?.configured}
          onClick={() => setExplaining(true)}
          className="flex items-center gap-2 rounded-md bg-[#50C878] px-3 py-2 text-sm font-semibold text-charcoal disabled:opacity-50 hover:brightness-110 transition"
        >
          <Bell className="w-4 h-4" /> Enable notifications on this device
        </button>
      )}

      {explaining && (
        <div className="rounded-lg border border-[#50C878]/40 bg-[#50C878]/10 p-3 space-y-2 text-sm text-gray-100">
          <p className="font-medium">Before you allow notifications</p>
          <ul className="list-disc pl-5 text-xs text-gray-300 space-y-1">
            <li>You&apos;ll get one notification when a card alert needs a category — e.g. &quot;$14.82 at McDonald&apos;s · Joint Visa — Eating Out or Dates?&quot;</li>
            <li>Only for the accounts you switch on below. Nothing for purchases a rule already filed.</li>
            <li>
              Your phone will ask once. If you tap <b>Don&apos;t Allow</b>, iPhone won&apos;t ask again until the Home Screen
              app is reinstalled.
            </li>
            {!support.installed && <li className="text-yellow-200">On iPhone, add Stash to your Home Screen first.</li>}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void enable()}
              className="flex items-center gap-2 rounded-md bg-[#50C878] px-3 py-2 text-sm font-semibold text-charcoal disabled:opacity-50"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Continue
            </button>
            <button
              type="button"
              onClick={() => setExplaining(false)}
              className="rounded-md bg-[#353535] px-3 py-2 text-sm text-gray-200 hover:text-white"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {enabledHere && (
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            disabled={busy}
            onClick={() => void sendTest()}
            className="flex items-center gap-2 rounded-md bg-[#353535] px-3 py-2 text-sm text-gray-200 hover:text-white hover:bg-[#404040] transition disabled:opacity-50"
          >
            <Send className="w-4 h-4" /> Send test notification
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void disableHere()}
            className="flex items-center gap-2 rounded-md bg-[#353535] px-3 py-2 text-sm text-gray-200 hover:text-white hover:bg-[#404040] transition disabled:opacity-50"
          >
            <BellOff className="w-4 h-4" /> Turn off on this device
          </button>
        </div>
      )}

      {prefs && prefs.accounts.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-gray-400">Notify me about purchases on:</p>
          {prefs.accounts.map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-sm text-gray-200">
              <input
                type="checkbox"
                checked={a.enabled}
                onChange={(e) => void toggle(a.id, e.target.checked)}
                className="accent-[#50C878]"
              />
              {a.name}
            </label>
          ))}
        </div>
      )}

      {timeout !== null && (
        <div className="pt-1 border-t border-charcoal-dark">
          <label htmlFor="answer-timeout" className="block text-xs text-gray-400 mt-3 mb-1.5">
            If nobody answers within (shared by both of you)
          </label>
          <select
            id="answer-timeout"
            value={timeout}
            onChange={(e) => void saveTimeout(Number(e.target.value))}
            className="rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-2 text-sm text-white focus:outline-none focus:border-[#50C878]"
          >
            {[2, 6, 12, 24, 48, 72, 168].map((h) => (
              <option key={h} value={h}>
                {h < 48 ? `${h} hours` : `${h / 24} days`}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1.5">
            …each account follows its own setting in Reconcile → Accounts: keep waiting, or file it as the guess.
          </p>
        </div>
      )}
    </div>
  );
}
