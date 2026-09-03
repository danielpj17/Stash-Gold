import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import {
  buildActivityLogInsert,
  parseActivityGroupingIds,
  type ActivityActor,
} from "@/lib/activityLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TransferClaimRow = {
  transfer_sheet_row_id: string;
  bank_hash: string;
  bank_account_name: string | null;
  bank_amount_cents: number;
  expected_legs: number;
  created_at: string;
};

type TransferClaimRequestBody = {
  transferRowId?: unknown;
  expectedLegs?: unknown;
  bankTransaction?: {
    hash?: unknown;
    accountName?: unknown;
    amount?: unknown;
  };
  actor?: unknown;
  csvUploadId?: unknown;
  bulkActionId?: unknown;
  parentActionId?: unknown;
};

function normalizeActor(value: unknown): ActivityActor {
  if (value === "auto_match" || value === "memory_match") return value;
  return "user";
}

function toCents(value: number): number {
  return Math.round(Number(value) * 100);
}

function normalizeExpectedLegs(value: unknown): 1 | 2 {
  const parsed = Number(value);
  return parsed === 1 ? 1 : 2;
}

export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    const rows = (await sql`
      SELECT transfer_sheet_row_id, bank_hash, bank_account_name, bank_amount_cents, expected_legs, created_at
      FROM reconciliation_transfer_claim_links
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `) as TransferClaimRow[];

    // `claimedAccounts` is which accounts already hold a leg. Consumers use it to
    // find the side still missing — by account identity, never by amount sign,
    // which depends on a per-account `outflow_is_positive` flag that detection
    // only guesses at. See the POST for what a wrong guess used to cost.
    const statusByRowId: Record<
      string,
      {
        claimedCount: number;
        expectedLegs: number;
        isComplete: boolean;
        claimedAccounts: string[];
      }
    > = {};
    for (const row of rows) {
      const rowId = String(row.transfer_sheet_row_id ?? "").trim();
      if (!rowId) continue;
      const expectedLegs = Number(row.expected_legs ?? 2) === 1 ? 1 : 2;
      if (!statusByRowId[rowId]) {
        statusByRowId[rowId] = {
          claimedCount: 0,
          expectedLegs,
          isComplete: false,
          claimedAccounts: [],
        };
      }
      statusByRowId[rowId].claimedCount += 1;
      if (expectedLegs < statusByRowId[rowId].expectedLegs) {
        statusByRowId[rowId].expectedLegs = expectedLegs;
      }
      const legAccount = String(row.bank_account_name ?? "").trim();
      if (legAccount && !statusByRowId[rowId].claimedAccounts.includes(legAccount)) {
        statusByRowId[rowId].claimedAccounts.push(legAccount);
      }
      statusByRowId[rowId].isComplete =
        statusByRowId[rowId].claimedCount >= statusByRowId[rowId].expectedLegs;
    }

    return NextResponse.json({
      claims: rows.map((row) => ({
        transferRowId: row.transfer_sheet_row_id,
        bankHash: row.bank_hash,
        bankAccountName: row.bank_account_name ?? undefined,
        bankAmountCents: Number(row.bank_amount_cents ?? 0),
        expectedLegs: Number(row.expected_legs ?? 2) === 1 ? 1 : 2,
        createdAt: row.created_at,
      })),
      statusByRowId,
    });
  } catch (err) {
    console.error("Transfer claims GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch transfer claims" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: TransferClaimRequestBody;
  try {
    body = (await request.json()) as TransferClaimRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const transferRowId = typeof body.transferRowId === "string" ? body.transferRowId.trim() : "";
  const bankHash = typeof body.bankTransaction?.hash === "string"
    ? body.bankTransaction.hash.trim()
    : "";
  const bankAccountName = typeof body.bankTransaction?.accountName === "string"
    ? body.bankTransaction.accountName.trim()
    : "";
  const bankAmount = Number(body.bankTransaction?.amount);
  const requestedExpectedLegs = normalizeExpectedLegs(body.expectedLegs);

  if (!transferRowId) {
    return NextResponse.json({ error: "transferRowId is required" }, { status: 400 });
  }
  if (!bankHash) {
    return NextResponse.json({ error: "bankTransaction.hash is required" }, { status: 400 });
  }
  if (!Number.isFinite(bankAmount) || toCents(bankAmount) === 0) {
    return NextResponse.json(
      { error: "bankTransaction.amount must be non-zero numeric" },
      { status: 400 },
    );
  }

  try {
    const existing = (await sql`
      SELECT transfer_sheet_row_id, bank_hash, bank_account_name, bank_amount_cents, expected_legs, created_at
      FROM reconciliation_transfer_claim_links
      WHERE user_id = ${userId} AND transfer_sheet_row_id = ${transferRowId}
      ORDER BY created_at ASC
    `) as TransferClaimRow[];

    const existingForHash = existing.find((row) => row.bank_hash === bankHash);
    if (existingForHash) {
      return NextResponse.json({
        success: true,
        transferRowId,
        alreadyClaimed: true,
        claimedCount: existing.length,
        expectedLegs: Number(existingForHash.expected_legs ?? 2) === 1 ? 1 : 2,
        isComplete:
          existing.length >= (Number(existingForHash.expected_legs ?? 2) === 1 ? 1 : 2),
      });
    }

    const effectiveExpectedLegs = existing.length > 0
      ? (Number(existing[0]?.expected_legs ?? 2) === 1 ? 1 : 2)
      : requestedExpectedLegs;

    if (existing.length >= effectiveExpectedLegs) {
      return NextResponse.json(
        { error: "Transfer row is already fully claimed." },
        { status: 409 },
      );
    }

    const newAmountCents = toCents(bankAmount);
    if (effectiveExpectedLegs === 2 && existing.length > 0) {
      /**
       * The two legs must be on two DIFFERENT accounts.
       *
       * This used to compare the legs' flow direction, derived from each
       * account's `outflow_is_positive`. That flag is a guess — detection sets
       * it true for any debit/credit-column file — and when it is wrong the
       * check rejects a perfectly good second leg. It did: AF Checking writes an
       * outgoing payment in its CREDIT column, which parses negative, while its
       * profile claims outflows are positive. Both legs of a real AF Checking →
       * Discover payment therefore read as "money arriving" and the claim was
       * refused.
       *
       * Account identity needs no convention and cannot be defeated by a
       * mis-detected flag: a transfer moves money between two accounts, so each
       * leg lands in a different account's statement. Two legs in one statement
       * are two transactions, not two legs of one.
       */
      const conflicting = existing.find(
        (row) => String(row.bank_account_name ?? "") === bankAccountName,
      );
      if (conflicting) {
        // Name the account still expected, when the transfer says who that is.
        const transferRows = (await sql`
          SELECT transfer_from, transfer_to
          FROM transactions
          WHERE user_id = ${userId} AND id = ${transferRowId} AND kind = 'transfer'
        `) as Array<{ transfer_from: string | null; transfer_to: string | null }>;
        const legs = [transferRows[0]?.transfer_from, transferRows[0]?.transfer_to]
          .map((id) => String(id ?? "").trim())
          .filter(Boolean);
        const otherSide = legs.find((id) => id !== bankAccountName);
        const otherName = otherSide
          ? ((
              await sql`
                SELECT name FROM financial_accounts
                WHERE user_id = ${userId} AND id = ${otherSide}::uuid
              `
            ) as Array<{ name: string }>)[0]?.name
          : undefined;

        return NextResponse.json(
          {
            error: otherName
              ? `That statement line is on the same account as the leg already claimed. The other leg should be on ${otherName}.`
              : "That statement line is on the same account as the leg already claimed. The other leg should be on the account on the other side of this transfer.",
          },
          { status: 409 },
        );
      }
    }

    const actor = normalizeActor(body.actor);
    const grouping = parseActivityGroupingIds(body);

    const { id: actionId, query: logInsert } = buildActivityLogInsert(sql, {
      userId,
      actionType: "transfer_claim_create",
      actor,
      payload: {
        transferRowId,
        bankHash,
        bankAccountName: bankAccountName || null,
        bankAmountCents: newAmountCents,
        expectedLegs: effectiveExpectedLegs,
      },
      csvUploadId: grouping.csvUploadId,
      bulkActionId: grouping.bulkActionId,
      parentActionId: grouping.parentActionId,
    });

    await sql.transaction([
      sql`
        INSERT INTO reconciliation_transfer_claim_links (
          user_id,
          transfer_sheet_row_id,
          bank_hash,
          bank_account_name,
          bank_amount_cents,
          expected_legs
        )
        VALUES (
          ${userId}::uuid,
          ${transferRowId},
          ${bankHash},
          ${bankAccountName || null},
          ${newAmountCents},
          ${effectiveExpectedLegs}
        )
      `,
      sql`
        INSERT INTO processed_transactions (user_id, hash, account_name)
        VALUES (${userId}::uuid, ${bankHash}, ${bankAccountName || null})
        ON CONFLICT (user_id, hash) DO UPDATE SET account_name = EXCLUDED.account_name
      `,
      // Claiming a pair clears its rejection — see the note in the claims route.
      sql`
        DELETE FROM reconciliation_rejected_matches
        WHERE user_id = ${userId}
          AND bank_hash = ${bankHash}
          AND sheet_name = 'Transfers'
          AND sheet_row_id = ${transferRowId}
      `,
      logInsert,
    ]);

    const claimedCount = existing.length + 1;
    const isComplete = claimedCount >= effectiveExpectedLegs;
    return NextResponse.json({
      success: true,
      transferRowId,
      claimedCount,
      expectedLegs: effectiveExpectedLegs,
      isComplete,
      actionId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save transfer claim";
    const isConflict = message.toLowerCase().includes("unique");
    return NextResponse.json({ error: message }, { status: isConflict ? 409 : 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: {
    bankTransaction?: {
      hash?: unknown;
      accountName?: unknown;
    };
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

  const bankHash = typeof body.bankTransaction?.hash === "string"
    ? body.bankTransaction.hash.trim()
    : "";
  const accountName = typeof body.bankTransaction?.accountName === "string"
    ? body.bankTransaction.accountName.trim()
    : "";

  if (!bankHash) {
    return NextResponse.json({ error: "bankTransaction.hash is required" }, { status: 400 });
  }

  const actor = normalizeActor(body.actor);
  const grouping = parseActivityGroupingIds(body);

  try {
    const existing = accountName
      ? ((await sql`
          SELECT transfer_sheet_row_id, bank_hash, bank_account_name, bank_amount_cents, expected_legs
          FROM reconciliation_transfer_claim_links
          WHERE user_id = ${userId} AND bank_hash = ${bankHash} AND bank_account_name = ${accountName}
        `) as TransferClaimRow[])
      : ((await sql`
          SELECT transfer_sheet_row_id, bank_hash, bank_account_name, bank_amount_cents, expected_legs
          FROM reconciliation_transfer_claim_links
          WHERE user_id = ${userId} AND bank_hash = ${bankHash}
        `) as TransferClaimRow[]);

    const { id: actionId, query: logInsert } = buildActivityLogInsert(sql, {
      userId,
      actionType: "transfer_claim_delete",
      actor,
      payload: {
        bankHash,
        accountName: accountName || null,
        deleted: existing.map((row) => ({
          transferRowId: row.transfer_sheet_row_id,
          bankAmountCents: Number(row.bank_amount_cents ?? 0),
          expectedLegs: Number(row.expected_legs ?? 2),
        })),
      },
      csvUploadId: grouping.csvUploadId,
      bulkActionId: grouping.bulkActionId,
      parentActionId: grouping.parentActionId,
    });

    const deleteQuery = accountName
      ? sql`
          DELETE FROM reconciliation_transfer_claim_links
          WHERE user_id = ${userId} AND bank_hash = ${bankHash} AND bank_account_name = ${accountName}
        `
      : sql`
          DELETE FROM reconciliation_transfer_claim_links
          WHERE user_id = ${userId} AND bank_hash = ${bankHash}
        `;

    await sql.transaction([deleteQuery, logInsert]);

    return NextResponse.json({
      success: true,
      bankHash,
      deleted: existing.length,
      // See the claims route: the caller turns these into rejected pairs.
      deletedLinks: existing.map((row) => ({
        sheetName: "Transfers",
        sheetRowId: row.transfer_sheet_row_id,
        accountName: row.bank_account_name ?? null,
      })),
      actionId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to remove transfer claim links" },
      { status: 502 },
    );
  }
}
