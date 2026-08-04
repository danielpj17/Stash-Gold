"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";
import { useRefresh } from "@/contexts/RefreshContext";
import type { FinancialAccount } from "@/lib/accounts";

type AccountsContextType = {
  accounts: FinancialAccount[];
  /** Active accounts only — what selectors and dropdowns should offer. */
  activeAccounts: FinancialAccount[];
  byId: Map<string, FinancialAccount>;
  /** Display name for an account id. Falls back to the id so archived or
   *  deleted accounts still render something recognisable rather than blank. */
  labelFor: (accountId: string) => string;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Replace local state after a settings mutation without a round trip. */
  setAccounts: (accounts: FinancialAccount[]) => void;
};

const AccountsContext = createContext<AccountsContextType | null>(null);

export function AccountsProvider({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const { refreshKey } = useRefresh();
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (status !== "authenticated") return;
    try {
      const res = await fetch("/api/accounts", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load accounts (${res.status})`);
      const data = (await res.json()) as { accounts?: FinancialAccount[] };
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    if (status === "loading") return;
    if (status !== "authenticated") {
      setAccounts([]);
      setLoading(false);
      return;
    }
    void refresh();
  }, [status, refreshKey, refresh]);

  const value = useMemo<AccountsContextType>(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return {
      accounts,
      activeAccounts: accounts.filter((a) => a.isActive),
      byId,
      labelFor: (accountId: string) => byId.get(accountId)?.name ?? accountId,
      loading,
      error,
      refresh,
      setAccounts,
    };
  }, [accounts, loading, error, refresh]);

  return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
}

export function useAccounts() {
  const ctx = useContext(AccountsContext);
  if (!ctx) throw new Error("useAccounts must be used within AccountsProvider");
  return ctx;
}
