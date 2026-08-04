"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";
import { useRefresh } from "@/contexts/RefreshContext";
import { CACHE_KEYS, readScopedCache, writeScopedCache } from "@/lib/clientCache";
import { getExpenses, getTransfers } from "@/services/transactionsApi";
import type { SheetRow, TransferRow } from "@/services/transactionsApi";

type ExpensesDataContextType = {
  allRows: SheetRow[];
  allTransfers: TransferRow[];
  loading: boolean;
  error: string | null;
};

const ExpensesDataContext = createContext<ExpensesDataContextType | null>(null);

type CachedData = {
  allRows: SheetRow[];
  allTransfers: TransferRow[];
};

/**
 * Fetches full-year expenses and transfers once (no month filter) and keeps them in memory.
 * Pages filter by selectedMonth client-side for instant month/page switching.
 * On return visits, renders immediately from localStorage while revalidating in the background.
 *
 * The cache is keyed by user id. The root layout seeds SessionProvider from the
 * server, so the id is already available in these useState initializers â€” no
 * empty flash while the session resolves.
 */
export function ExpensesDataProvider({ children }: { children: ReactNode }) {
  const { refreshKey } = useRefresh();
  const { data: session, status } = useSession();
  const userId = session?.user?.id ?? null;

  const [allRows, setAllRows] = useState<SheetRow[]>(
    () => readScopedCache<CachedData>(CACHE_KEYS.expenses, userId)?.allRows ?? [],
  );
  const [allTransfers, setAllTransfers] = useState<TransferRow[]>(
    () => readScopedCache<CachedData>(CACHE_KEYS.expenses, userId)?.allTransfers ?? [],
  );
  const [loading, setLoading] = useState(
    () => readScopedCache<CachedData>(CACHE_KEYS.expenses, userId) === null,
  );
  const [error, setError] = useState<string | null>(null);

  // Swap in the new user's cached data if the signed-in user changes without a
  // full reload; drop the previous user's rows immediately either way.
  useEffect(() => {
    const cached = readScopedCache<CachedData>(CACHE_KEYS.expenses, userId);
    setAllRows(cached?.allRows ?? []);
    setAllTransfers(cached?.allTransfers ?? []);
  }, [userId]);

  useEffect(() => {
    if (status !== "authenticated" || !userId) {
      // Signed out (or still resolving): nothing to fetch, and "no session" is
      // not the same as "no data" â€” don't report an error for it.
      setLoading(status === "loading");
      return;
    }

    let cancelled = false;
    setError(null);

    Promise.all([getExpenses(), getTransfers()])
      .then(([rows, transfers]) => {
        if (!cancelled) {
          setAllRows(rows);
          setAllTransfers(transfers);
          writeScopedCache(CACHE_KEYS.expenses, userId, { allRows: rows, allTransfers: transfers });
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, status, userId]);

  return (
    <ExpensesDataContext.Provider
      value={{ allRows, allTransfers, loading, error }}
    >
      {children}
    </ExpensesDataContext.Provider>
  );
}

export function useExpensesData() {
  const ctx = useContext(ExpensesDataContext);
  if (!ctx) throw new Error("useExpensesData must be used within ExpensesDataProvider");
  return ctx;
}
