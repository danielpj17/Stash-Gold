/**
 * localStorage keys used by the app. Every one of these holds user data, so
 * every one has to be namespaced by user id — otherwise signing in as a second
 * person on the same browser renders the first person's cached data.
 */
export const CACHE_KEYS = {
  expenses: "stash_expenses_v1",
  budgets: "stash_budgets_v1",
  reconcile: "reconcile-page-state-v3",
  investmentCalculator: "stash_investment_calculator_v1",
} as const;

/**
 * Namespace a cache key by user.
 *
 * Returns null when there is no user yet — callers must treat that as
 * "no cache available", never as "cache is empty". The distinction matters
 * because `useSession()` resolves after the first render, and a `useState`
 * initializer that reads cache runs before it.
 */
export function userScopedKey(base: string, userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `${base}::${userId}`;
}

export function readScopedCache<T>(base: string, userId: string | null | undefined): T | null {
  const key = userScopedKey(base, userId);
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeScopedCache(
  base: string,
  userId: string | null | undefined,
  value: unknown,
): void {
  const key = userScopedKey(base, userId);
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled — caching is best-effort.
  }
}

/**
 * Wipe every trace of the current user from the browser before signing out:
 * all scoped caches (plus any unscoped keys left over from before this change)
 * and the whole Cache Storage, so no stale API response survives the switch.
 */
export async function purgeClientCaches(): Promise<void> {
  if (typeof window === "undefined") return;

  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (key.startsWith("stash") || key.startsWith("reconcile-") || key.startsWith("financial-dashboard-")) {
        doomed.push(key);
      }
    }
    doomed.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Storage unavailable — nothing to purge.
  }

  try {
    if ("caches" in window) {
      const names = await window.caches.keys();
      await Promise.all(names.map((name) => window.caches.delete(name)));
    }
  } catch {
    // Cache Storage unavailable — nothing to purge.
  }
}
