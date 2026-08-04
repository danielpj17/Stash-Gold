import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UploadedFileRow = {
  account_name: string;
  file_name: string;
  created_at: string;
  bank_hashes: string[] | null;
};

export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    const rows = (await sql`
      SELECT account_name, file_name, created_at
      FROM reconciliation_uploaded_files
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `) as UploadedFileRow[];

    const filesByAccount: Record<string, string[]> = {};
    for (const row of rows) {
      const account = String(row.account_name ?? "").trim();
      const file = String(row.file_name ?? "").trim();
      if (!account || !file) continue;
      if (!filesByAccount[account]) filesByAccount[account] = [];
      if (!filesByAccount[account].includes(file)) {
        filesByAccount[account].push(file);
      }
    }

    return NextResponse.json({ filesByAccount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch uploaded files" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { accountName?: unknown; fileName?: unknown; bankHashes?: unknown };
  try {
    body = (await request.json()) as { accountName?: unknown; fileName?: unknown; bankHashes?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  const bankHashes = Array.isArray(body.bankHashes)
    ? body.bankHashes.map((h) => String(h)).filter(Boolean)
    : null;

  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }
  if (!fileName) {
    return NextResponse.json({ error: "fileName is required" }, { status: 400 });
  }

  try {
    await sql`
      INSERT INTO reconciliation_uploaded_files (user_id, account_name, file_name, bank_hashes)
      VALUES (${userId}::uuid, ${accountName}, ${fileName}, ${bankHashes ? JSON.stringify(bankHashes) : null}::jsonb)
      ON CONFLICT (user_id, account_name, file_name)
      DO UPDATE SET bank_hashes = EXCLUDED.bank_hashes, created_at = now()
    `;
    return NextResponse.json({ success: true, accountName, fileName });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save uploaded file" },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { accountName?: unknown; fileName?: unknown };
  try {
    body = (await request.json()) as { accountName?: unknown; fileName?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";

  if (!accountName || !fileName) {
    return NextResponse.json({ error: "accountName and fileName are required" }, { status: 400 });
  }

  try {
    // Fetch the stored bank hashes for this file.
    const fileRows = (await sql`
      SELECT bank_hashes
      FROM reconciliation_uploaded_files
      WHERE user_id = ${userId} AND account_name = ${accountName} AND file_name = ${fileName}
    `) as Array<{ bank_hashes: string[] | null }>;

    const rawHashes = fileRows[0]?.bank_hashes;
    const hashes: string[] = Array.isArray(rawHashes)
      ? rawHashes.map((h) => String(h)).filter(Boolean)
      : [];

    if (hashes.length > 0) {
      // Remove all reconciliation state for these bank hashes.
      await sql.transaction([
        sql`DELETE FROM reconciliation_claim_links
            WHERE user_id = ${userId} AND bank_hash = ANY(${hashes}::text[])`,
        sql`DELETE FROM reconciliation_transfer_claim_links
            WHERE user_id = ${userId} AND bank_hash = ANY(${hashes}::text[])`,
        sql`DELETE FROM processed_transactions
            WHERE user_id = ${userId} AND hash = ANY(${hashes}::text[])`,
        sql`DELETE FROM reconciliation_statement_dismissals
            WHERE user_id = ${userId} AND hash = ANY(${hashes}::text[])`,
        sql`DELETE FROM reconciliation_match_cache
            WHERE user_id = ${userId} AND bank_hash = ANY(${hashes}::text[])`,
      ]);
    }

    // Delete the file record itself.
    await sql`
      DELETE FROM reconciliation_uploaded_files
      WHERE user_id = ${userId} AND account_name = ${accountName} AND file_name = ${fileName}
    `;

    return NextResponse.json({ success: true, clearedHashes: hashes });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to clear file" },
      { status: 502 },
    );
  }
}
