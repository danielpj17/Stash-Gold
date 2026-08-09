"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { ArrowLeft } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import HouseholdPanel from "@/components/HouseholdPanel";
import SignOutButton from "@/components/SignOutButton";

/**
 * Settings — sharing and sign-out.
 *
 * Reached from the gear on New Expense, which is deliberate rather than a nav
 * entry: `Sidebar` is `standalone:hidden` and `BottomNav` has five fixed icons
 * with no overflow, so in the installed PWA a page-level control is the only
 * thing that can reach here. The gear sits on New Expense because that is the
 * app's landing surface on a phone.
 *
 * Sign-out is duplicated here and in the sidebar on purpose: the sidebar is the
 * habit on desktop, and it doesn't exist in the PWA. Both go through
 * `SignOutButton` so the client-cache purge can't be forgotten in one of them.
 *
 * (An earlier `/settings` route existed for account management and was removed;
 * accounts still live under Reconcile → Accounts. This one is not that page.)
 */
export default function SettingsPage() {
  const { data: session } = useSession();
  const email = session?.user?.email ?? "";

  return (
    <DashboardLayout>
      {/* Centred to match New Expense — same narrow-column shape, same reason. */}
      <div className="space-y-6 max-w-2xl mx-auto">
        {/*
          A link to New Expense rather than history.back(): Settings is also
          reachable from the sidebar's email line, and from there "back" would
          be wherever you happened to be. This always lands where the gear was.
          Styled to match the "← All" control on Reconcile.
        */}
        <div className="flex items-center gap-3">
          <Link
            href="/new-expense"
            title="Back to New Expense"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-sm hover:text-white hover:bg-[#2d2d2d] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden />
            Back
          </Link>
          <h1 className="text-xl font-semibold text-white">Settings</h1>
        </div>

        <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-medium">Sharing</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Let someone else sign in with their own email and use this same budget.
            </p>
          </div>
          <div className="p-4">
            <HouseholdPanel />
          </div>
        </section>

        <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-medium">Account</h2>
          </div>
          <div className="p-4 space-y-3">
            {email && (
              <p className="text-sm text-gray-400 break-all">
                Signed in as <span className="text-gray-200">{email}</span>
              </p>
            )}
            <SignOutButton />
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}
