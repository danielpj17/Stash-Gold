import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MemoryRow = {
  fingerprint: string;
  bank_account_name: string;
  sheet_category: string | null;
  sheet_account: string | null;
  confirmed_count: number;
  last_confirmed_at: string;
};

export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    const rows = (await sql`
      SELECT fingerprint, bank_account_name, sheet_category, sheet_account, confirmed_count, last_confirmed_at
      FROM reconciliation_merchant_memory
      WHERE user_id = ${userId}
      ORDER BY confirmed_count DESC, last_confirmed_at DESC
    `) as MemoryRow[];

    return NextResponse.json({
      entries: rows.map((row) => ({
        fingerprint: row.fingerprint,
        bankAccountName: row.bank_account_name,
        sheetCategory: row.sheet_category,
        sheetAccount: row.sheet_account,
        confirmedCount: Number(row.confirmed_count ?? 0),
        lastConfirmedAt: row.last_confirmed_at,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch merchant memory" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: {
    fingerprint?: unknown;
    bankAccountName?: unknown;
    sheetCategory?: unknown;
    sheetAccount?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  const bankAccountName =
    typeof body.bankAccountName === "string" ? body.bankAccountName.trim() : "";
  const sheetCategory =
    typeof body.sheetCategory === "string" && body.sheetCategory.trim()
      ? body.sheetCategory.trim()
      : null;
  const sheetAccount =
    typeof body.sheetAccount === "string" && body.sheetAccount.trim()
      ? body.sheetAccount.trim()
      : null;

  if (!fingerprint) {
    return NextResponse.json({ error: "fingerprint is required" }, { status: 400 });
  }
  if (!bankAccountName) {
    return NextResponse.json({ error: "bankAccountName is required" }, { status: 400 });
  }

  try {
    const rows = (await sql`
      INSERT INTO reconciliation_merchant_memory (
        user_id, fingerprint, bank_account_name, sheet_category, sheet_account, confirmed_count
      )
      VALUES (${userId}::uuid, ${fingerprint}, ${bankAccountName}, ${sheetCategory}, ${sheetAccount}, 1)
      ON CONFLICT (user_id, fingerprint, bank_account_name) DO UPDATE SET
        confirmed_count = reconciliation_merchant_memory.confirmed_count + 1,
        last_confirmed_at = now(),
        sheet_category = COALESCE(EXCLUDED.sheet_category, reconciliation_merchant_memory.sheet_category),
        sheet_account = COALESCE(EXCLUDED.sheet_account, reconciliation_merchant_memory.sheet_account)
      RETURNING fingerprint, bank_account_name, confirmed_count
    `) as Array<{ fingerprint: string; bank_account_name: string; confirmed_count: number }>;

    const row = rows[0];
    return NextResponse.json({
      success: true,
      fingerprint,
      bankAccountName,
      confirmedCount: Number(row?.confirmed_count ?? 1),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to upsert merchant memory" },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { fingerprint?: unknown; bankAccountName?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  const bankAccountName =
    typeof body.bankAccountName === "string" ? body.bankAccountName.trim() : "";

  if (!fingerprint || !bankAccountName) {
    return NextResponse.json(
      { error: "fingerprint and bankAccountName are required" },
      { status: 400 },
    );
  }

  try {
    const rows = (await sql`
      DELETE FROM reconciliation_merchant_memory
      WHERE user_id = ${userId} AND fingerprint = ${fingerprint} AND bank_account_name = ${bankAccountName}
      RETURNING fingerprint
    `) as Array<{ fingerprint: string }>;

    return NextResponse.json({ success: true, deleted: rows.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete merchant memory" },
      { status: 502 },
    );
  }
}
