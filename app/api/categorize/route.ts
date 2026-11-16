import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { loadQueue } from "@/lib/categorize";
import { EMAIL_SYNC_CONFIG } from "@/lib/email/config";
import { getEmailSyncSettings } from "@/lib/email/settings";
import { settleUnattended } from "@/lib/email/unattended";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The To categorize queue (plan §5.10). Session only, household-scoped: both
 * people see one queue, and whoever answers first wins (see [id]).
 *
 * Every read also runs the unattended settle for this scope (plan §5.9), so
 * overdue items follow their account's setting even if the poller is down.
 *
 * ?summary=1 returns only the badge count and the poller-staleness flag, for
 * the banner on New Expense and Budget.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    try {
      await settleUnattended(sql, userId);
    } catch {
      /* migration 007 not applied yet: nothing to settle */
    }

    if (request.nextUrl.searchParams.get("summary") === "1") {
      const [counts, settings] = await Promise.all([
        sql`
          SELECT
            (SELECT count(*)::int FROM transactions WHERE user_id = ${userId} AND review_status = 'needs_review') AS needs_review,
            (SELECT count(*)::int FROM transactions WHERE user_id = ${userId} AND duplicate_of IS NOT NULL) AS duplicates,
            (SELECT count(*)::int FROM email_events WHERE user_id = ${userId} AND status = 'ambiguous') AS ambiguous,
            (SELECT count(*)::int FROM email_events WHERE user_id = ${userId} AND status IN ('unparsed', 'unknown_account')
               AND created_at > now() - interval '30 days') AS unreadable
        ` as unknown as Promise<Array<{ needs_review: number; duplicates: number; ambiguous: number; unreadable: number }>>,
        getEmailSyncSettings(sql, userId),
      ]);
      const c = counts[0] ?? { needs_review: 0, duplicates: 0, ambiguous: 0, unreadable: 0 };
      const hbAge = settings.lastHeartbeatAt ? (Date.now() - Date.parse(settings.lastHeartbeatAt)) / 3_600_000 : null;
      return NextResponse.json({
        count: Number(c.needs_review) + Number(c.ambiguous) + Number(c.duplicates),
        needsReview: Number(c.needs_review),
        ambiguous: Number(c.ambiguous),
        duplicates: Number(c.duplicates),
        unreadable: Number(c.unreadable),
        // Only once a poller has ever checked in — a Stash that never set up
        // email sync must not nag about it.
        pollerStale: hbAge !== null && hbAge > EMAIL_SYNC_CONFIG.heartbeatBannerHours,
        pollerFailureAt: settings.lastPollerFailureAt,
        mode: settings.mode,
      });
    }

    return NextResponse.json(await loadQueue(sql, userId));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load the queue" },
      { status: 502 },
    );
  }
}
