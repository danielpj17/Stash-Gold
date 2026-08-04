"use client";

import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";
import { MonthProvider } from "@/contexts/MonthContext";
import { RefreshProvider } from "@/contexts/RefreshContext";
import { AccountsProvider } from "@/contexts/AccountsContext";
import { ExpensesDataProvider } from "@/contexts/ExpensesDataContext";

export default function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  return (
    // The session is seeded from the server layout, and it lasts 90 days, so
    // there is nothing worth refetching — and each refetch would be a DB round
    // trip on the free tier.
    <SessionProvider session={session} refetchInterval={0} refetchOnWindowFocus={false}>
      <MonthProvider>
        <RefreshProvider>
          <AccountsProvider>
            <ExpensesDataProvider>{children}</ExpensesDataProvider>
          </AccountsProvider>
        </RefreshProvider>
      </MonthProvider>
    </SessionProvider>
  );
}
