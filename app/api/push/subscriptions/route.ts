import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { pushConfigured, vapidPublicKey } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * This person's push devices. Session only.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPES ON `actorId`, NOT `userId` — like /api/tokens. A phone belongs to a
 * person. Scoping on the household would let each spouse see and remove the
 * other's devices.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * GET also returns the VAPID public key. It is served here rather than via a
 * NEXT_PUBLIC_ variable, which would be inlined at build time.
 */
export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, actorId } = ctx;

  try {
    const rows = (await sql`
      SELECT id, endpoint, device_label, created_at, last_success_at, last_failure_at, failure_count
        FROM push_subscriptions WHERE user_id = ${actorId}
       ORDER BY created_at DESC
    `) as Array<Record<string, unknown>>;
    return NextResponse.json({
      configured: pushConfigured(),
      publicKey: vapidPublicKey(),
      subscriptions: rows.map((r) => ({
        id: r.id,
        // The endpoint identifies this browser to the client; the full URL is
        // a capability, so only its tail is sent back for display.
        endpointTail: String(r.endpoint).slice(-12),
        deviceLabel: r.device_label,
        createdAt: r.created_at,
        lastSuccessAt: r.last_success_at,
        lastFailureAt: r.last_failure_at,
        failureCount: Number(r.failure_count ?? 0),
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 502 });
  }
}

/** Register this browser: the PushSubscription JSON plus an optional label. */
export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, actorId } = ctx;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const sub = (body.subscription ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint : "";
  const p256dh = typeof sub.keys?.p256dh === "string" ? sub.keys.p256dh : "";
  const auth = typeof sub.keys?.auth === "string" ? sub.keys.auth : "";
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth || endpoint.length > 2000) {
    return NextResponse.json({ error: "Invalid push subscription" }, { status: 400 });
  }
  const label = typeof body.deviceLabel === "string" ? body.deviceLabel.trim().slice(0, 80) : null;

  try {
    // The same endpoint under ANOTHER person (a shared phone whose previous
    // user never signed out) is left alone: deleting by endpoint would be a
    // cross-user delete. Sign-out removes its own row (SignOutButton).
    await sql`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_label)
      VALUES (${actorId}::uuid, ${endpoint}, ${p256dh}, ${auth}, ${label})
      ON CONFLICT (user_id, endpoint) DO UPDATE
        SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
            device_label = COALESCE(EXCLUDED.device_label, push_subscriptions.device_label),
            failure_count = 0
    `;
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 502 });
  }
}

/** Remove one of YOUR devices: { endpoint } or { id }. */
export async function DELETE(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, actorId } = ctx;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* fall through to validation */
  }
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
  const id = typeof body.id === "string" ? body.id : null;
  if (!endpoint && !id) return NextResponse.json({ error: "endpoint or id is required" }, { status: 400 });

  try {
    const rows = (await sql`
      DELETE FROM push_subscriptions
       WHERE user_id = ${actorId}
         AND ((${endpoint}::text IS NOT NULL AND endpoint = ${endpoint})
           OR (${id}::uuid IS NOT NULL AND id = ${id}::uuid))
      RETURNING id
    `) as Array<{ id: string }>;
    return NextResponse.json({ removed: rows.length });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 502 });
  }
}
