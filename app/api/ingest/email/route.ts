import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { EMAIL_SYNC_CONFIG } from "@/lib/email/config";
import { validateEmailPayload } from "@/lib/email/payload";
import { bodySha256, processEvent } from "@/lib/email/pipeline";
import { getEmailSyncSettings } from "@/lib/email/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST one alert email from the Gmail poller (apps-script/poller.gs).
 *
 * Bearer token with purpose 'email' ONLY — never a session, never a Shortcut
 * token. The token resolves the data scope; the body carries no identity.
 *
 * Response contract with the poller (plan §5.1):
 *   2xx            processed (or already processed) — label the message
 *   401 / 403      bad or revoked key — stop the run
 *   429 / 5xx      transient — stop the run, label nothing, retry next minute
 *   other 4xx      a poison message — label it rejected and move on
 *
 * So a 5xx is reserved for errors a retry can fix (the database). A parser bug
 * becomes `unparsed` with a 200, because retrying it would fail identically
 * every minute for a week.
 *
 * NEVER log the request body: it would put bank email into the Vercel logs.
 */
export async function POST(request: NextRequest) {
  const ctx = await requireUser(request, { bearerPurpose: "email" });
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId, via } = ctx;
  if (via !== "token") {
    return NextResponse.json(
      { error: "Send an email-sync key: Authorization: Bearer stsh_…" },
      { status: 401 },
    );
  }

  // Size guard. The script caps at 1 MB, so this only ever stops a misbehaving
  // client. 413 (not 429) so a permanently oversized message is labelled
  // rejected instead of blocking the queue forever.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > EMAIL_SYNC_CONFIG.maxBodyBytes) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "Could not read body" }, { status: 400 });
  }
  if (raw.length > EMAIL_SYNC_CONFIG.maxBodyBytes) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const payload = validateEmailPayload(body);
  if ("error" in payload) return NextResponse.json({ error: payload.error }, { status: 400 });

  try {
    const recent = (await sql`
      SELECT count(*)::int AS n FROM email_events
       WHERE user_id = ${userId} AND created_at > now() - interval '1 minute'
    `) as Array<{ n: number }>;
    if (Number(recent[0]?.n ?? 0) >= EMAIL_SYNC_CONFIG.maxEventsPerMinute) {
      return NextResponse.json({ error: "Too many emails in the last minute" }, { status: 429 });
    }

    const settings = await getEmailSyncSettings(sql, userId);

    // 2. Store first, then process. A repeat is a no-op only once the event
    //    is TERMINAL; one still in `received` (a request that died half-way)
    //    is re-processed (C14), and the unique email_event_id index on
    //    transactions makes that unable to double-insert.
    const inserted = (await sql`
      INSERT INTO email_events (
        user_id, gmail_message_id, rfc822_message_id, from_address, to_address,
        forwarded_for, subject, received_at, auth_results, arc_auth_results,
        raw_text, raw_html, body_sha256, truncated, mode_at_receipt
      )
      VALUES (
        ${userId}::uuid, ${payload.gmailMessageId}, ${payload.rfc822MessageId}, ${payload.from},
        ${payload.to}, ${payload.headers.xForwardedFor}, ${payload.subject}, ${payload.date}::timestamptz,
        ${payload.headers.authenticationResults}, ${payload.headers.arcAuthenticationResults},
        ${payload.plainBody}, ${payload.htmlBody}, ${bodySha256(payload.plainBody, payload.htmlBody)},
        ${payload.truncated}, ${settings.mode}
      )
      ON CONFLICT (user_id, gmail_message_id) DO NOTHING
      RETURNING id
    `) as Array<{ id: string }>;

    let eventId = inserted[0]?.id ?? null;
    if (!eventId) {
      const existing = (await sql`
        SELECT id, status, transaction_id FROM email_events
         WHERE user_id = ${userId} AND gmail_message_id = ${payload.gmailMessageId}
      `) as Array<{ id: string; status: string; transaction_id: string | null }>;
      const row = existing[0];
      if (!row) return NextResponse.json({ error: "Event vanished; retry" }, { status: 503 });
      if (row.status !== "received") {
        return NextResponse.json({
          eventId: row.id,
          status: row.status,
          transactionId: row.transaction_id,
          duplicate: true,
        });
      }
      eventId = row.id;
    }

    await sql`
      INSERT INTO email_sync_settings (user_id, last_ingest_at, poller_version)
      VALUES (${userId}::uuid, now(), ${payload.pollerVersion})
      ON CONFLICT (user_id) DO UPDATE
        SET last_ingest_at = now(),
            poller_version = COALESCE(EXCLUDED.poller_version, email_sync_settings.poller_version),
            updated_at = now()
    `;

    // Dev-only hook for acceptance check 6: die between "stored" and "done",
    // leaving the event in `received` so the retry has to complete it.
    if (process.env.NODE_ENV !== "production" && process.env.EMAIL_SYNC_FAIL_AFTER_STORE === "1") {
      throw new Error("EMAIL_SYNC_FAIL_AFTER_STORE is set (dev test hook)");
    }

    const result = await processEvent(sql, userId, eventId);
    return NextResponse.json({ eventId, ...result, duplicate: false });
  } catch (err) {
    // Infrastructure failure: the event (if stored) stays `received` and the
    // poller's retry re-processes it.
    console.error("email-sync: ingest failed", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Temporary failure; will retry" }, { status: 503 });
  }
}
