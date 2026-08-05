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
  /** Live accounts — what the manage-accounts list shows. Excludes deleted. */
  accounts: FinancialAccount[];
  /** Live and not archived — what selectors and dropdowns should offer. */
  activeAccounts: FinancialAccount[];
  /** The user's default account, where un-attributed expenses land. */
  defaultAccount: FinancialAccount | null;
  /**
   * Includes soft-deleted accounts, so `labelFor` can still name an account
   * that past reconciliation history references.
   */
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
    // byId spans everything, including deleted, so history stays labeled.
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const live = accounts.filter((a) => !a.isDeleted);
    return {
      accounts: live,
      activeAccounts: live.filter((a) => a.isActive),
      defaultAccount: live.find((a) => a.isDefault) ?? live[0] ?? null,
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
