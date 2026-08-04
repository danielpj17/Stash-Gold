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

type UserDismissalRow = {
  sheet_name: string;
  sheet_row_id: string;
  note: string;
  created_at: string;
};

function claimKey(sheetName: string, sheetRowId: string): string {
  return `${sheetName}:${sheetRowId}`;
}

export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    const rows = (await sql`
      SELECT sheet_name, sheet_row_id, note, created_at
      FROM reconciliation_user_sheet_dismissals
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `) as UserDismissalRow[];

    return NextResponse.json({
      dismissedKeys: rows.map((r) => claimKey(r.sheet_name, r.sheet_row_id)),
      dismissals: rows.map((r) => ({
        sheetName: r.sheet_name,
        sheetRowId: r.sheet_row_id,
        note: r.note,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Reconciliation user-dismissals GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch user dismissals" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { sheetName?: unknown; sheetRowId?: unknown; note?: unknown };
  try {
    body = (await request.json()) as { sheetName?: unknown; sheetRowId?: unknown; note?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sheetName =
    typeof body.sheetName === "string" ? body.sheetName.trim() : "";
  const sheetRowId =
    typeof body.sheetRowId === "string" ? body.sheetRowId.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";

  if (sheetName !== "Expenses" && sheetName !== "Transfers") {
    return NextResponse.json(
      { error: "sheetName must be Expenses or Transfers" },
      { status: 400 },
    );
  }
  if (!sheetRowId) {
    return NextResponse.json({ error: "sheetRowId is required" }, { status: 400 });
  }
  if (!note) {
    return NextResponse.json({ error: "note is required" }, { status: 400 });
  }

  const actor = normalizeActor((body as { actor?: unknown }).actor);
  const grouping = parseActivityGroupingIds(body);

  try {
    const { id: actionId, query: logInsert } = buildActivityLogInsert(sql, {
      userId,
      actionType: "user_dismiss_create",
      actor,
      payload: { sheetName, sheetRowId, note },
      csvUploadId: grouping.csvUploadId,
      bulkActionId: grouping.bulkActionId,
      parentActionId: grouping.parentActionId,
    });

    await sql.transaction([
      sql`
        INSERT INTO reconciliation_user_sheet_dismissals (user_id, sheet_name, sheet_row_id, note)
        VALUES (${userId}::uuid, ${sheetName}, ${sheetRowId}, ${note})
        ON CONFLICT (user_id, sheet_name, sheet_row_id) DO UPDATE SET note = EXCLUDED.note
      `,
      logInsert,
    ]);
    return NextResponse.json({
      success: true,
      key: claimKey(sheetName, sheetRowId),
      sheetName,
      sheetRowId,
      note,
      actionId,
    });
  } catch (err) {
    console.error("Reconciliation user-dismissals POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save user dismissal" },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: {
    sheetName?: unknown;
    sheetRowId?: unknown;
    actor?: unknown;
    csvUploadId?: unknown;
    bulkActionId?: unknown;
    parentActionId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sheetName = typeof body.sheetName === "string" ? body.sheetName.trim() : "";
  const sheetRowId = typeof body.sheetRowId === "string" ? body.sheetRowId.trim() : "";

  if (sheetName !== "Expenses" && sheetName !== "Transfers") {
    return NextResponse.json({ error: "sheetName must be Expenses or Transfers" }, { status: 400 });
  }
  if (!sheetRowId) {
    return NextResponse.json({ error: "sheetRowId is required" }, { status: 400 });
  }

  const actor = normalizeActor(body.actor);
  const grouping = parseActivityGroupingIds(body);

  try {
    const existing = (await sql`
      SELECT sheet_name, sheet_row_id, note
      FROM reconciliation_user_sheet_dismissals
      WHERE user_id = ${userId} AND sheet_name = ${sheetName} AND sheet_row_id = ${sheetRowId}
    `) as UserDismissalRow[];

    const { id: actionId, query: logInsert } = buildActivityLogInsert(sql, {
      userId,
      actionType: "user_dismiss_delete",
      actor,
      payload: {
        sheetName,
        sheetRowId,
        deleted: existing.map((r) => ({ sheetName: r.sheet_name, sheetRowId: r.sheet_row_id, note: r.note })),
      },
      csvUploadId: grouping.csvUploadId,
      bulkActionId: grouping.bulkActionId,
      parentActionId: grouping.parentActionId,
    });

    await sql.transaction([
      sql`
        DELETE FROM reconciliation_user_sheet_dismissals
        WHERE user_id = ${userId} AND sheet_name = ${sheetName} AND sheet_row_id = ${sheetRowId}
      `,
      logInsert,
    ]);

    return NextResponse.json({
      success: true,
      key: claimKey(sheetName, sheetRowId),
      deleted: existing.length,
      actionId,
    });
  } catch (err) {
    console.error("Reconciliation user-dismissals DELETE error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete user dismissal" },
      { status: 502 },
    );
  }
}
