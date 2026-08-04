import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import type { Sql } from "@/lib/db";
import { buildActivityLogInsert } from "@/lib/activityLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActivityRow = {
  id: string;
  action_type: string;
  actor: string;
  csv_upload_id: string | null;
  payload: any;
  reverted_at: string | null;
};

/**
 * Undo a previously logged reconciliation action.
 *
 * Each action_type has a defined inverse. The inverse mutation runs in the
 * same transaction as marking the original action as reverted and inserting
 * a counter-log entry, so the audit trail stays consistent.
 *
 * Conflict rules:
 * - claim_delete undo (re-create) fails if the sheet row is now claimed elsewhere.
 * - quick_log undo only removes the claim — never deletes the user's sheet row.
 * - Already-reverted actions return 200 with `noop: true`.
 *
 * SECURITY: the lookup is by (id, user_id), never by id alone. Undo *writes* to
 * claim links, processed rows, and dismissals, so an id-only lookup would let
 * any signed-in user mutate another user's reconciliation state by guessing a
 * UUID. Every statement in buildUndoQueries carries user_id for the same reason,
 * including the ones hidden inside NOT EXISTS subqueries.
 */
export async function POST(
  _request: NextRequest,
  context: { params: { id: string } },
) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  const id = String(context.params.id ?? "").trim();
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const matches = (await sql`
      SELECT id, action_type, actor, csv_upload_id, payload, reverted_at
      FROM reconciliation_activity_log
      WHERE id = ${id}::uuid AND user_id = ${userId}
      LIMIT 1
    `) as ActivityRow[];

    const original = matches[0];
    if (!original) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404 });
    }
    if (original.reverted_at) {
      return NextResponse.json({ noop: true, reason: "Already reverted" });
    }

    const undoQueries = await buildUndoQueries(sql, userId, original);
    if (!undoQueries) {
      return NextResponse.json(
        { error: `Action type "${original.action_type}" cannot be undone automatically.` },
        { status: 422 },
      );
    }

    const { id: undoActionId, query: undoLogInsert } = buildActivityLogInsert(sql, {
      userId,
      actionType: inverseActionType(original.action_type),
      actor: "user",
      payload: { undidActionId: original.id, originalPayload: original.payload },
      csvUploadId: original.csv_upload_id,
      parentActionId: original.id,
    });

    const markReverted = sql`
      UPDATE reconciliation_activity_log
      SET reverted_at = now(), reverted_by_action_id = ${undoActionId}::uuid
      WHERE id = ${original.id}::uuid AND user_id = ${userId} AND reverted_at IS NULL
    `;

    await sql.transaction([...undoQueries, markReverted, undoLogInsert]);

    return NextResponse.json({
      success: true,
      undoActionId,
      originalActionId: original.id,
      originalActionType: original.action_type,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to undo activity";
    const isConflict = message.toLowerCase().includes("unique");
    return NextResponse.json({ error: message }, { status: isConflict ? 409 : 502 });
  }
}

function inverseActionType(actionType: string): any {
  // Counter-log uses a paired type so the activity feed shows the relationship.
  const map: Record<string, string> = {
    claim_create: "claim_delete",
    claim_delete: "claim_create",
    transfer_claim_create: "transfer_claim_delete",
    transfer_claim_delete: "transfer_claim_create",
    dismiss_create: "dismiss_delete",
    dismiss_delete: "dismiss_create",
    user_dismiss_create: "user_dismiss_delete",
    user_dismiss_delete: "user_dismiss_create",
    processed_mark: "processed_unmark",
    processed_unmark: "processed_mark",
    quick_log: "claim_delete",
  };
  return map[actionType] ?? actionType;
}

/**
 * Returns the SQL query fragments needed to undo this action. Returns null
 * when the action type has no defined inverse.
 *
 * NOTE: We never delete sheet rows the user added (quick_log undo only
 * removes the claim link, leaving the sheet entry intact).
 */
async function buildUndoQueries(
  sql: Sql,
  userId: string,
  original: ActivityRow,
): Promise<any[] | null> {
  const p = original.payload ?? {};

  switch (original.action_type) {
    case "claim_create":
    case "quick_log": {
      // Remove the claim links; clear processed if no remaining claims.
      const bankHash = String(p.bankHash ?? "").trim();
      if (!bankHash) return null;
      return [
        sql`
          DELETE FROM reconciliation_claim_links
          WHERE user_id = ${userId} AND bank_hash = ${bankHash}
        `,
        sql`
          DELETE FROM processed_transactions
          WHERE user_id = ${userId} AND hash = ${bankHash}
            AND NOT EXISTS (
              SELECT 1 FROM reconciliation_transfer_claim_links
              WHERE user_id = ${userId} AND bank_hash = ${bankHash}
            )
            AND NOT EXISTS (
              SELECT 1 FROM reconciliation_statement_dismissals
              WHERE user_id = ${userId} AND hash = ${bankHash}
            )
        `,
      ];
    }

    case "claim_delete": {
      const bankHash = String(p.bankHash ?? "").trim();
      const accountName = p.accountName ? String(p.accountName) : null;
      const links = Array.isArray(p.deletedLinks) ? p.deletedLinks : [];
      if (!bankHash || links.length === 0) return null;
      const sheetNames = links.map((l: any) => String(l.sheetName ?? "Expenses"));
      const sheetRowIds = links.map((l: any) => String(l.sheetRowId ?? ""));
      const amountCents = links.map((l: any) => Number(l.amountCents ?? 0));
      return [
        sql`
          INSERT INTO reconciliation_claim_links (
            user_id, bank_hash, account_name, sheet_name, sheet_row_id, amount_cents
          )
          SELECT ${userId}::uuid, ${bankHash}, ${accountName}, links.sheet_name, links.sheet_row_id, links.amount_cents
          FROM unnest(
            ${sheetNames}::text[],
            ${sheetRowIds}::text[],
            ${amountCents}::integer[]
          ) AS links(sheet_name, sheet_row_id, amount_cents)
        `,
        sql`
          INSERT INTO processed_transactions (user_id, hash, account_name)
          VALUES (${userId}::uuid, ${bankHash}, ${accountName})
          ON CONFLICT (user_id, hash) DO UPDATE SET account_name = EXCLUDED.account_name
        `,
      ];
    }

    case "transfer_claim_create": {
      const bankHash = String(p.bankHash ?? "").trim();
      if (!bankHash) return null;
      return [
        sql`
          DELETE FROM reconciliation_transfer_claim_links
          WHERE user_id = ${userId} AND bank_hash = ${bankHash}
        `,
        sql`
          DELETE FROM processed_transactions
          WHERE user_id = ${userId} AND hash = ${bankHash}
            AND NOT EXISTS (
              SELECT 1 FROM reconciliation_claim_links
              WHERE user_id = ${userId} AND bank_hash = ${bankHash}
            )
            AND NOT EXISTS (
              SELECT 1 FROM reconciliation_statement_dismissals
              WHERE user_id = ${userId} AND hash = ${bankHash}
            )
        `,
      ];
    }

    case "transfer_claim_delete": {
      const bankHash = String(p.bankHash ?? "").trim();
      const accountName = p.accountName ? String(p.accountName) : null;
      const deleted = Array.isArray(p.deleted) ? p.deleted : [];
      if (!bankHash || deleted.length === 0) return null;
      const inserts = deleted.map((d: any) => sql`
        INSERT INTO reconciliation_transfer_claim_links (
          user_id, transfer_sheet_row_id, bank_hash, bank_account_name, bank_amount_cents, expected_legs
        )
        VALUES (
          ${userId}::uuid,
          ${String(d.transferRowId)},
          ${bankHash},
          ${accountName},
          ${Number(d.bankAmountCents ?? 0)},
          ${Number(d.expectedLegs ?? 2) === 1 ? 1 : 2}
        )
      `);
      inserts.push(sql`
        INSERT INTO processed_transactions (user_id, hash, account_name)
        VALUES (${userId}::uuid, ${bankHash}, ${accountName})
        ON CONFLICT (user_id, hash) DO UPDATE SET account_name = EXCLUDED.account_name
      `);
      return inserts;
    }

    case "dismiss_create": {
      const hash = String(p.hash ?? "").trim();
      const accountName = String(p.accountName ?? "").trim();
      if (!hash || !accountName) return null;
      return [
        sql`
          DELETE FROM reconciliation_statement_dismissals
          WHERE user_id = ${userId} AND hash = ${hash} AND account_name = ${accountName}
        `,
        sql`
          DELETE FROM processed_transactions
          WHERE user_id = ${userId} AND hash = ${hash}
            AND NOT EXISTS (
              SELECT 1 FROM reconciliation_claim_links
              WHERE user_id = ${userId} AND bank_hash = ${hash}
            )
            AND NOT EXISTS (
              SELECT 1 FROM reconciliation_transfer_claim_links
              WHERE user_id = ${userId} AND bank_hash = ${hash}
            )
        `,
      ];
    }

    case "dismiss_delete": {
      const deleted = Array.isArray(p.deleted) ? p.deleted : [];
      if (deleted.length === 0) return null;
      return deleted.map((d: any) => sql`
        INSERT INTO reconciliation_statement_dismissals (user_id, hash, account_name, note)
        VALUES (${userId}::uuid, ${String(d.hash)}, ${String(d.accountName)}, ${String(d.note ?? "")})
        ON CONFLICT (user_id, hash, account_name) DO UPDATE SET note = EXCLUDED.note
      `);
    }

    case "user_dismiss_create": {
      const sheetName = String(p.sheetName ?? "").trim();
      const sheetRowId = String(p.sheetRowId ?? "").trim();
      if (!sheetName || !sheetRowId) return null;
      return [
        sql`
          DELETE FROM reconciliation_user_sheet_dismissals
          WHERE user_id = ${userId} AND sheet_name = ${sheetName} AND sheet_row_id = ${sheetRowId}
        `,
      ];
    }

    case "user_dismiss_delete": {
      const deleted = Array.isArray(p.deleted) ? p.deleted : [];
      if (deleted.length === 0) return null;
      return deleted.map((d: any) => sql`
        INSERT INTO reconciliation_user_sheet_dismissals (user_id, sheet_name, sheet_row_id, note)
        VALUES (${userId}::uuid, ${String(d.sheetName)}, ${String(d.sheetRowId)}, ${String(d.note ?? "")})
        ON CONFLICT (user_id, sheet_name, sheet_row_id) DO UPDATE SET note = EXCLUDED.note
      `);
    }

    case "processed_mark": {
      const hash = String(p.hash ?? "").trim();
      if (!hash) return null;
      return [
        sql`
          DELETE FROM processed_transactions
          WHERE user_id = ${userId} AND hash = ${hash}
            AND NOT EXISTS (
              SELECT 1 FROM reconciliation_claim_links
              WHERE user_id = ${userId} AND bank_hash = ${hash}
            )
            AND NOT EXISTS (
              SELECT 1 FROM reconciliation_transfer_claim_links
              WHERE user_id = ${userId} AND bank_hash = ${hash}
            )
            AND NOT EXISTS (
              SELECT 1 FROM reconciliation_statement_dismissals
              WHERE user_id = ${userId} AND hash = ${hash}
            )
        `,
      ];
    }

    case "processed_unmark": {
      const hash = String(p.hash ?? "").trim();
      const accountName = p.accountName ? String(p.accountName) : null;
      if (!hash) return null;
      return [
        sql`
          INSERT INTO processed_transactions (user_id, hash, account_name)
          VALUES (${userId}::uuid, ${hash}, ${accountName})
          ON CONFLICT (user_id, hash) DO UPDATE SET account_name = EXCLUDED.account_name
        `,
      ];
    }

    default:
      return null;
  }
}
