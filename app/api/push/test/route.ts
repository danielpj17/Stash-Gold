import { NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { pushConfigured, sendTestToActor } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Send test notification" — to the signed-in PERSON's own devices only (actorId). */
export async function POST() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, actorId } = ctx;

  if (!pushConfigured()) {
    return NextResponse.json(
      { error: "Push isn't configured on the server (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT)." },
      { status: 503 },
    );
  }
  try {
    return NextResponse.json(await sendTestToActor(sql, actorId));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 502 });
  }
}
