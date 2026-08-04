import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import {
  buildActivityLogInsert,
  parseActivityGroupingIds,
  type ActivityActor,
} from "@/lib/activityLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DismissalRow = {
  hash: string;
  account_name: string;
  note: string;
  created_at: string;
};

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
      SELECT hash, account_name, note, created_at
      FROM reconciliation_statement_dismissals
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `) as DismissalRow[];

    return NextResponse.json({
      dismissals: rows.map((r) => ({
        hash: r.hash,
        accountName: r.account_name ?? "",
        note: r.note,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Reconciliation dismissals GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch dismissals" },
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

  const hash =
    typeof (body as { hash?: unknown })?.hash === "string"
      ? (body as { hash: string }).hash.trim()
      : "";
  const accountName =
    typeof (body as { accountName?: unknown })?.accountName === "string"
      ? (body as { accountName: string }).accountName.trim()
      : "";
  const note =
    typeof (body as { note?: unknown })?.note === "string"
      ? (body as { note: string }).note.trim()
      : "";

  if (!hash) {
    return NextResponse.json({ error: "hash is required" }, { status: 400 });
  }
  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }
  if (!note) {
    return NextResponse.json({ error: "note is required" }, { status: 400 });
  }

  const actor = normalizeActor((body as { actor?: unknown }).actor);
  const grouping = parseActivityGroupingIds(body);

  try {
    const { id: actionId, query: logInsert } = buildActivityLogInsert(sql, {
      userId,
      actionType: "dismiss_create",
      actor,
      payload: { hash, accountName, note },
      csvUploadId: grouping.csvUploadId,
      bulkActionId: grouping.bulkActionId,
      parentActionId: grouping.parentActionId,
    });

    await sql.transaction([
      sql`
        INSERT INTO reconciliation_statement_dismissals (user_id, hash, account_name, note)
        VALUES (${userId}::uuid, ${hash}, ${accountName}, ${note})
        ON CONFLICT (user_id, hash, account_name) DO UPDATE SET note = EXCLUDED.note
      `,
      sql`
        INSERT INTO processed_transactions (user_id, hash, account_name)
        VALUES (${userId}::uuid, ${hash}, ${accountName})
        ON CONFLICT (user_id, hash) DO UPDATE SET account_name = EXCLUDED.account_name
      `,
      logInsert,
    ]);
    return NextResponse.json({ success: true, hash, accountName, note, actionId });
  } catch (err) {
    console.error("Reconciliation dismissals POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save dismissal" },
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

  const hash =
    typeof (body as { hash?: unknown })?.hash === "string"
      ? (body as { hash: string }).hash.trim()
      : "";
  const accountName =
    typeof (body as { accountName?: unknown })?.accountName === "string"
      ? (body as { accountName: string }).accountName.trim()
      : "";

  if (!hash) {
    return NextResponse.json({ error: "hash is required" }, { status: 400 });
  }

  const actor = normalizeActor((body as { actor?: unknown }).actor);
  const grouping = parseActivityGroupingIds(body);

  try {
    const existing = accountName
      ? ((await sql`
          SELECT hash, account_name, note
          FROM reconciliation_statement_dismissals
          WHERE user_id = ${userId} AND hash = ${hash} AND account_name = ${accountName}
        `) as DismissalRow[])
      : ((await sql`
          SELECT hash, account_name, note
          FROM reconciliation_statement_dismissals
          WHERE user_id = ${userId} AND hash = ${hash}
        `) as DismissalRow[]);

    const { id: actionId, query: logInsert } = buildActivityLogInsert(sql, {
      userId,
      actionType: "dismiss_delete",
      actor,
      payload: {
        hash,
        accountName: accountName || null,
        deleted: existing.map((row) => ({
          hash: row.hash,
          accountName: row.account_name,
          note: row.note,
        })),
      },
      csvUploadId: grouping.csvUploadId,
      bulkActionId: grouping.bulkActionId,
      parentActionId: grouping.parentActionId,
    });

    const deleteQuery = accountName
      ? sql`
          DELETE FROM reconciliation_statement_dismissals
          WHERE user_id = ${userId} AND hash = ${hash} AND account_name = ${accountName}
        `
      : sql`
          DELETE FROM reconciliation_statement_dismissals
          WHERE user_id = ${userId} AND hash = ${hash}
        `;

    await sql.transaction([deleteQuery, logInsert]);

    return NextResponse.json({
      success: true,
      hash,
      deleted: existing.length,
      actionId,
    });
  } catch (err) {
    console.error("Reconciliation dismissals DELETE error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete dismissal" },
      { status: 502 },
    );
  }
}
