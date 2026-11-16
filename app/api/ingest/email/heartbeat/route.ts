import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { validateHeartbeat } from "@/lib/email/payload";
import { getEmailSyncSettings } from "@/lib/email/settings";
import { settleUnattended } from "@/lib/email/unattended";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The poller's check-in, every 15 minutes (plan C2). Bearer 'email' token only.
 *
 * This replaces a Vercel cron: it runs the unattended settle for THIS token's
 * scope only, so no cross-user query ever exists, and Settings turns amber
 * when check-ins stop — which is how a broken trigger (re-auth needed, quota)
 * gets noticed.
 */
export async function POST(request: NextRequest) {
  const ctx = await requireUser(request, { bearerPurpose: "email" });
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId, via } = ctx;
  if (via !== "token") {
    return NextResponse.json({ error: "Send an email-sync key" }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty heartbeat is still a heartbeat.
  }
  const hb = validateHeartbeat(body);

  try {
    await sql`
      INSERT INTO email_sync_settings (user_id, last_heartbeat_at, last_heartbeat_error, last_poll_at, poller_version)
      VALUES (${userId}::uuid, now(), ${hb.lastError}, ${hb.lastPollAt}::timestamptz, ${hb.pollerVersion})
      ON CONFLICT (user_id) DO UPDATE
        SET last_heartbeat_at = now(),
            last_heartbeat_error = EXCLUDED.last_heartbeat_error,
            last_poll_at = COALESCE(EXCLUDED.last_poll_at, email_sync_settings.last_poll_at),
            poller_version = COALESCE(EXCLUDED.poller_version, email_sync_settings.poller_version),
            updated_at = now()
    `;

    let settled = { confirmed: 0, settled: 0 };
    try {
      settled = await settleUnattended(sql, userId);
    } catch (err) {
      // Push tables may not exist yet (migration 007); the heartbeat itself
      // must still succeed or Settings would falsely report the poller dead.
      console.error("email-sync: unattended settle failed", err instanceof Error ? err.message : err);
    }

    const settings = await getEmailSyncSettings(sql, userId);
    return NextResponse.json({ ok: true, mode: settings.mode, ...settled });
  } catch (err) {
    console.error("email-sync: heartbeat failed", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Temporary failure" }, { status: 503 });
  }
}
