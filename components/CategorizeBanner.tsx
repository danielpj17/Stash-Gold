"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Tags } from "lucide-react";
import { useRefresh } from "@/contexts/RefreshContext";

type Summary = {
  count: number;
  needsReview: number;
  ambiguous: number;
  duplicates: number;
  unreadable: number;
  pollerStale: boolean;
  pollerFailureAt: string | null;
  mode: "shadow" | "live";
};

/**
 * The To categorize count, on New Expense and Budget (D5). There is no sixth
 * nav icon, so this banner plus push deep links are how the queue is reached
 * in the installed PWA.
 *
 * Also carries the poller-staleness warning after 6 h with no check-in,
 * because nobody visits Settings — and it stays silent for a Stash that never
 * set up email sync.
 */
export default function CategorizeBanner() {
  const { refreshKey } = useRefresh();
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/categorize?summary=1", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Summary | null) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        /* email sync not set up — show nothing */
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!summary) return null;
  const showQueue = summary.count > 0;
  const showStale = summary.pollerStale;
  if (!showQueue && !showStale) return null;

  return (
    <div className="space-y-2">
      {showQueue && (
        <Link
          href="/categorize"
          className="flex items-center gap-3 rounded-xl border border-[#50C878]/40 bg-[#50C878]/10 px-4 py-3 text-sm text-gray-100 hover:bg-[#50C878]/15 transition-colors"
        >
          <Tags className="w-5 h-5 text-[#50C878] shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="font-semibold text-white">{summary.count}</span>{" "}
            {summary.count === 1 ? "purchase" : "purchases"} to categorize
            {summary.duplicates > 0 && (
              <span className="text-gray-400"> · {summary.duplicates} possible duplicate{summary.duplicates === 1 ? "" : "s"}</span>
            )}
          </span>
          <span className="text-[#50C878] text-xs font-medium shrink-0">Open</span>
        </Link>
      )}
      {showStale && (
        <Link
          href="/settings/email-sync"
          className="flex items-center gap-3 rounded-xl border border-yellow-400/40 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-100 hover:bg-yellow-400/15 transition-colors"
        >
          <AlertTriangle className="w-5 h-5 text-yellow-300 shrink-0" />
          <span className="flex-1 min-w-0">
            Email sync hasn&apos;t checked in for over 6 hours — card alerts aren&apos;t arriving.
          </span>
          <span className="text-yellow-200 text-xs font-medium shrink-0">Check</span>
        </Link>
      )}
    </div>
  );
}
