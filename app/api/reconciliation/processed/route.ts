import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import {
  buildActivityLogInsert,
  parseActivityGroupingIds,
  type ActivityActor,
} from "@/lib/activityLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeActor(value: unknown): ActivityActor {
  if (value === "auto_match" || value === "memory_match") return value;
  return "user";
}

export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    const rows = (await sql`
      SELECT hash
      FROM processed_transactions
      WHERE user_id = ${userId}
      ORDER BY processed_at DESC
    `) as { hash: string }[];
    return NextResponse.json({ hashes: rows.map((r) => r.hash) });
  } catch (err) {
    console.error("Processed transactions GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch processed hashes" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const hash = typeof (body as { hash?: unknown })?.hash === "string"
    ? (body as { hash: string }).hash.trim()
    : "";
  const accountName = typeof (body as { accountName?: unknown })?.accountName === "string"
    ? (body as { accountName: string }).accountName.trim()
    : "";

  if (!hash) {
    return NextResponse.json({ error: "hash is required" }, { status: 400 });
  }

  const actor = normalizeActor((body as { actor?: unknown }).actor);
  const grouping = parseActivityGroupingIds(body);

  try {
    const existing = (await sql`
      SELECT hash FROM processed_transactions WHERE user_id = ${userId} AND hash = ${hash}
    `) as Array<{ hash: string }>;
    const wasAlreadyProcessed = existing.length > 0;

    if (wasAlreadyProcessed) {
      return NextResponse.json({ success: true, hash, actionId: null, skipped: true });
    }

    const { id: actionId, query: logInsert } = buildActivityLogInsert(sql, {
      userId,
      actionType: "processed_mark",
      actor,
      payload: { hash, accountName: accountName || null, wasAlreadyProcessed },
      csvUploadId: grouping.csvUploadId,
      bulkActionId: grouping.bulkActionId,
      parentActionId: grouping.parentActionId,
    });

    await sql.transaction([
      sql`
        INSERT INTO processed_transactions (user_id, hash, account_name)
        VALUES (${userId}::uuid, ${hash}, ${accountName || null})
        ON CONFLICT (user_id, hash) DO UPDATE SET account_name = EXCLUDED.account_name
      `,
      logInsert,
    ]);
    return NextResponse.json({ success: true, hash, actionId });
  } catch (err) {
    console.error("Processed transactions POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save processed hash" },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const hash = typeof (body as { hash?: unknown })?.hash === "string"
    ? (body as { hash: string }).hash.trim()
    : "";
  const accountName = typeof (body as { accountName?: unknown })?.accountName === "string"
    ? (body as { accountName: string }).accountName.trim()
    : "";

  if (!hash) {
    return NextResponse.json({ error: "hash is required" }, { status: 400 });
  }

  const actor = normalizeActor((body as { actor?: unknown }).actor);
  const grouping = parseActivityGroupingIds(body);

  try {
    const { id: actionId, query: logInsert } = buildActivityLogInsert(sql, {
      userId,
      actionType: "processed_unmark",
      actor,
      payload: { hash, accountName: accountName || null },
      csvUploadId: grouping.csvUploadId,
      bulkActionId: grouping.bulkActionId,
      parentActionId: grouping.parentActionId,
    });

    const deleteQuery = accountName
      ? sql`
          DELETE FROM processed_transactions
          WHERE user_id = ${userId} AND hash = ${hash} AND account_name = ${accountName}
        `
      : sql`
          DELETE FROM processed_transactions
          WHERE user_id = ${userId} AND hash = ${hash}
        `;

    await sql.transaction([deleteQuery, logInsert]);

    return NextResponse.json({
      success: true,
      hash,
      actionId,
    });
  } catch (err) {
    console.error("Processed transactions DELETE error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete processed hash" },
      { status: 502 },
    );
  }
}
