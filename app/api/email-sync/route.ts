import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { EMAIL_SYNC_CONFIG } from "@/lib/email/config";
import { parserOptions } from "@/lib/email/registry";
import { getEmailSyncSettings, normalizeCounterparty } from "@/lib/email/settings";
import { pushConfigured } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Email sync status and settings for Settings → Email sync. Session only.
 * Scoped on `userId` (the household): both people see and steer one sync.
 * The email KEY itself is per person and lives in /api/tokens.
 */
export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    const settings = await getEmailSyncSettings(sql, userId);
    const [counts, review] = await Promise.all([
      sql`
        SELECT status, count(*)::int AS n FROM email_events
         WHERE user_id = ${userId} GROUP BY status
      ` as unknown as Promise<Array<{ status: string; n: number }>>,
      sql`
        SELECT count(*) FILTER (WHERE review_status = 'needs_review')::int AS needs_review,
               count(*) FILTER (WHERE duplicate_of IS NOT NULL)::int AS duplicates
          FROM transactions WHERE user_id = ${userId}
      ` as unknown as Promise<Array<{ needs_review: number; duplicates: number }>>,
    ]);

    const byStatus = Object.fromEntries(counts.map((r) => [r.status, Number(r.n)]));
    const heartbeatAgeMinutes = settings.lastHeartbeatAt
      ? (Date.now() - Date.parse(settings.lastHeartbeatAt)) / 60_000
      : null;

    return NextResponse.json({
      settings,
      counts: byStatus,
      toCategorize: Number(review[0]?.needs_review ?? 0) + Number(byStatus.ambiguous ?? 0),
      possibleDuplicates: Number(review[0]?.duplicates ?? 0),
      heartbeat: {
        ageMinutes: heartbeatAgeMinutes,
        stale: heartbeatAgeMinutes !== null && heartbeatAgeMinutes > EMAIL_SYNC_CONFIG.heartbeatStaleMinutes,
        bannerStale: heartbeatAgeMinutes !== null && heartbeatAgeMinutes > EMAIL_SYNC_CONFIG.heartbeatBannerHours * 60,
        staleAfterMinutes: EMAIL_SYNC_CONFIG.heartbeatStaleMinutes,
      },
      parsers: parserOptions(),
      pushConfigured: pushConfigured(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load email sync status" },
      { status: 502 },
    );
  }
}

/**
 * Update { mode?, answerTimeoutHours?, internalCounterparties? }.
 *
 * Switching to live never backfills: every event remembers the mode it
 * arrived under, so mail that came in during shadow stays shadow forever.
 */
export async function PATCH(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const current = await getEmailSyncSettings(sql, userId);
  const mode = body.mode === "live" || body.mode === "shadow" ? body.mode : current.mode;

  let timeout = current.answerTimeoutHours;
  if (body.answerTimeoutHours !== undefined) {
    const n = Number(body.answerTimeoutHours);
    if (!Number.isInteger(n) || n < 1 || n > 168) {
      return NextResponse.json({ error: "Answer timeout must be 1–168 hours" }, { status: 400 });
    }
    timeout = n;
  }

  let counterparties = current.internalCounterparties;
  if (body.internalCounterparties !== undefined) {
    if (!Array.isArray(body.internalCounterparties)) {
      return NextResponse.json({ error: "internalCounterparties must be a list of names" }, { status: 400 });
    }
    counterparties = [
      ...new Set(
        body.internalCounterparties
          .map((n) => (typeof n === "string" ? normalizeCounterparty(n) : ""))
          .filter((n) => n.length > 0 && n.length <= 100),
      ),
    ].slice(0, 20);
  }

  try {
    await sql`
      INSERT INTO email_sync_settings (user_id, mode, answer_timeout_hours, internal_counterparties)
      VALUES (${userId}::uuid, ${mode}, ${timeout}, ${counterparties}::text[])
      ON CONFLICT (user_id) DO UPDATE
        SET mode = EXCLUDED.mode,
            answer_timeout_hours = EXCLUDED.answer_timeout_hours,
            internal_counterparties = EXCLUDED.internal_counterparties,
            updated_at = now()
    `;
    return NextResponse.json({ settings: await getEmailSyncSettings(sql, userId) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save settings" },
      { status: 502 },
    );
  }
}
