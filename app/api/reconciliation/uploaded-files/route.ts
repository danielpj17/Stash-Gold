import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { getBankProfile } from "@/lib/accounts";
import type { Sql } from "@/lib/db";
import { computeCsvIdentityKeys } from "@/services/reconciliationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Keeps each replace transaction within the Neon HTTP driver limits.
const CSV_SAVE_CHUNK_SIZE = 15;

/** Order must match csv-rows: it determines the -N hash suffixes. */
async function readStoredRowsForAccount(
  sql: Sql,
  userId: string,
  accountName: string,
): Promise<string[][]> {
  const rows = (await sql`
    SELECT cells
    FROM reconciliation_csv_rows
    WHERE user_id = ${userId} AND account_name = ${accountName}
    ORDER BY created_at ASC, seq ASC
  `) as Array<{ cells: unknown }>;
  return rows
    .map((r) => (Array.isArray(r.cells) ? r.cells.map((c: unknown) => String(c ?? "")) : null))
    .filter((cells): cells is string[] => cells !== null && cells.length > 0);
}

/**
 * Delete the stored CSV rows behind `targets` for one account.
 *
 * Clearing a file has to reach the raw rows: they are the source the reconcile
 * page re-reads on load and identity-merges the next upload into, so a file
 * whose rows survive comes straight back on the next upload.
 *
 * Occurrences of one identity are interchangeable, so when N members of a group
 * are targeted this drops the N highest-numbered rows rather than the exact ones
 * named. Dropping X while keeping X-2 would renumber the survivor to X on the
 * next read and orphan every claim keyed to X-2.
 */
async function removeStoredRowsForHashes(
  sql: Sql,
  userId: string,
  accountName: string,
  targets: Set<string>,
): Promise<{ removedHashes: string[]; rows: string[][] }> {
  const existing = await readStoredRowsForAccount(sql, userId, accountName);
  if (existing.length === 0 || targets.size === 0) {
    return { removedHashes: [], rows: existing };
  }

  const profile = await getBankProfile(sql, userId, accountName);
  const keys = computeCsvIdentityKeys(accountName, existing, profile);

  const groups = new Map<string, Array<{ index: number; hash: string; targeted: boolean }>>();
  existing.forEach((_row, i) => {
    const key = keys[i];
    if (!key.startsWith("id:")) return; // headers / unparseable rows are always kept
    const hash = key.slice(3);
    const base = hash.replace(/-\d+$/, "");
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base)!.push({ index: i, hash, targeted: targets.has(hash) });
  });

  const dropIndices = new Set<number>();
  const removedHashes: string[] = [];
  for (const members of groups.values()) {
    const dropCount = members.filter((m) => m.targeted).length;
    if (dropCount === 0) continue;
    for (const member of members.slice(members.length - dropCount)) {
      dropIndices.add(member.index);
      removedHashes.push(member.hash);
    }
  }

  if (dropIndices.size === 0) return { removedHashes: [], rows: existing };

  const keptRows = existing.filter((_row, i) => !dropIndices.has(i));
  const keptKeys = keys.filter((_key, i) => !dropIndices.has(i));

  // Replace the account's stored rows with the kept set. The DELETE rides with
  // the first insert chunk so a failed write can never silently wipe the account.
  const inserts = keptRows.map((cells, i) =>
    sql`
      INSERT INTO reconciliation_csv_rows (user_id, account_name, dedupe_key, cells)
      VALUES (${userId}::uuid, ${accountName}, ${keptKeys[i]}, ${JSON.stringify(cells)}::jsonb)
      ON CONFLICT (user_id, account_name, dedupe_key)
      DO UPDATE SET cells = EXCLUDED.cells, created_at = now()
    `,
  );

  if (inserts.length === 0) {
    await sql`
      DELETE FROM reconciliation_csv_rows
      WHERE user_id = ${userId} AND account_name = ${accountName}
    `;
    return { removedHashes, rows: [] };
  }

  for (let i = 0; i < inserts.length; i += CSV_SAVE_CHUNK_SIZE) {
    const chunk = inserts.slice(i, i + CSV_SAVE_CHUNK_SIZE);
    await sql.transaction(
      i === 0
        ? [
            sql`
              DELETE FROM reconciliation_csv_rows
              WHERE user_id = ${userId} AND account_name = ${accountName}
            `,
            ...chunk,
          ]
        : chunk,
    );
  }

  return { removedHashes, rows: keptRows };
}

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

    // Statements overlap, so the same transaction can belong to more than one
    // uploaded file. Anything another surviving file still covers stays put —
    // clearing one month must not take the neighbouring month's rows with it.
    const otherFileRows = (await sql`
      SELECT bank_hashes
      FROM reconciliation_uploaded_files
      WHERE user_id = ${userId}
        AND account_name = ${accountName}
        AND file_name <> ${fileName}
    `) as Array<{ bank_hashes: string[] | null }>;

    const keepHashes = new Set<string>();
    for (const row of otherFileRows) {
      if (!Array.isArray(row.bank_hashes)) continue;
      for (const h of row.bank_hashes) {
        const hash = String(h);
        if (hash) keepHashes.add(hash);
      }
    }

    const targetHashes = hashes.filter((h) => !keepHashes.has(h));

    // Remove this file's raw CSV rows. Without this the reconciliation state
    // below is cleared but the rows remain, so the page re-reads them on load
    // and the next upload identity-merges into them — the cleared statement
    // reappears in full.
    const { removedHashes, rows: remainingRows } = await removeStoredRowsForHashes(
      sql,
      userId,
      accountName,
      new Set(targetHashes),
    );

    const clearedHashes = Array.from(new Set([...targetHashes, ...removedHashes])).filter(
      (h) => !keepHashes.has(h),
    );

    if (clearedHashes.length > 0) {
      // Remove all reconciliation state for these bank hashes.
      await sql.transaction([
        sql`DELETE FROM reconciliation_claim_links
            WHERE user_id = ${userId} AND bank_hash = ANY(${clearedHashes}::text[])`,
        sql`DELETE FROM reconciliation_transfer_claim_links
            WHERE user_id = ${userId} AND bank_hash = ANY(${clearedHashes}::text[])`,
        sql`DELETE FROM processed_transactions
            WHERE user_id = ${userId} AND hash = ANY(${clearedHashes}::text[])`,
        sql`DELETE FROM reconciliation_statement_dismissals
            WHERE user_id = ${userId} AND hash = ANY(${clearedHashes}::text[])`,
        sql`DELETE FROM reconciliation_match_cache
            WHERE user_id = ${userId} AND bank_hash = ANY(${clearedHashes}::text[])`,
      ]);
    }

    // Delete the file record itself.
    await sql`
      DELETE FROM reconciliation_uploaded_files
      WHERE user_id = ${userId} AND account_name = ${accountName} AND file_name = ${fileName}
    `;

    return NextResponse.json({
      success: true,
      clearedHashes,
      removedRowCount: removedHashes.length,
      rows: remainingRows,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to clear file" },
      { status: 502 },
    );
  }
}
