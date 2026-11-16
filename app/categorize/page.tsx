"use client";

import Link from "next/link";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import CategorizeQueue from "@/components/CategorizeQueue";

/**
 * To categorize (plan §5.10). Reached from the banner on New Expense and
 * Budget, and from push notifications — there is deliberately no nav icon
 * (D5). The list is CategorizeQueue so it can later move into Reconcile.
 */
export default function CategorizePage() {
  return (
    <DashboardLayout>
      <div className="space-y-4 max-w-2xl mx-auto">
        <div className="flex items-center gap-3">
          <Link
            href="/new-expense"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-sm hover:text-white hover:bg-[#2d2d2d] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden />
            Back
          </Link>
          <h1 className="text-xl font-semibold text-white flex-1">To categorize</h1>
          <Link
            href="/rules"
            title="Merchant rules"
            className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-[#50C878] transition-colors"
          >
            <SlidersHorizontal className="w-4 h-4" />
            Rules
          </Link>
        </div>
        <p className="text-xs text-gray-400">
          Purchases from card alerts that need a category. A guessed category already counts in its
          budget bar, marked <span className="text-yellow-200/90">unconfirmed</span>, until someone
          picks.
        </p>
        <CategorizeQueue />
      </div>
    </DashboardLayout>
  );
}
