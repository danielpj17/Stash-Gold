import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { getBankProfile } from "@/lib/accounts";
import type { Sql } from "@/lib/db";
import { mergeCsvRowsByIdentity } from "@/services/reconciliationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Insert chunk size — keeps each transaction within the Neon HTTP driver limits.
const CSV_SAVE_CHUNK_SIZE = 15;

type CsvRowRecord = {
  account_name: string;
  dedupe_key: string;
  cells: string[];
};

function csvRowDedupeKey(row: string[]): string {
  return row.map((c) => String(c).trim()).join("\t");
}

function toCells(row: unknown): string[] | null {
  if (!Array.isArray(row)) return null;
  return row.map((c: unknown) => (c === null || c === undefined ? "" : String(c)));
}

/**
 * Row order matters: it drives the -2/-3 suffixes disambiguateHashes() appends
 * to duplicate bank hashes, which are the keys reconciliation_claim_links uses.
 * created_at alone is ambiguous (it is transaction time, so a whole chunk
 * shares one value), so seq breaks the tie deterministically.
 */
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

export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    const rows = (await sql`
      SELECT account_name, cells
      FROM reconciliation_csv_rows
      WHERE user_id = ${userId}
      ORDER BY created_at ASC, seq ASC
    `) as CsvRowRecord[];

    const rowsByAccount: Record<string, string[][]> = {};
    for (const row of rows) {
      const account = String(row.account_name ?? "").trim();
      if (!account) continue;
      const cells = Array.isArray(row.cells)
        ? row.cells.map((c: unknown) => String(c ?? ""))
        : [];
      if (cells.length === 0) continue;
      if (!rowsByAccount[account]) rowsByAccount[account] = [];
      rowsByAccount[account].push(cells);
    }

    return NextResponse.json({ rowsByAccount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch CSV rows" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { accountName?: unknown; rows?: unknown; merge?: unknown };
  try {
    body = (await request.json()) as { accountName?: unknown; rows?: unknown; merge?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }
  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: "rows must be an array" }, { status: 400 });
  }

  const incoming: string[][] = [];
  for (const row of body.rows) {
    const cells = toCells(row);
    if (cells && csvRowDedupeKey(cells)) incoming.push(cells);
  }

  try {
    // --- Merge mode: identity-merge incoming with stored rows, then replace. ---
    if (body.merge === true) {
      const profile = await getBankProfile(sql, userId, accountName);
      const existing = await readStoredRowsForAccount(sql, userId, accountName);
      const merged = mergeCsvRowsByIdentity(accountName, existing, incoming, profile);

      // Replace stored rows for the account. The DELETE rides with the first
      // insert chunk so an empty/failed write never wipes existing data silently.
      const inserts = merged.rows.map((cells, i) =>
        sql`
          INSERT INTO reconciliation_csv_rows (user_id, account_name, dedupe_key, cells)
          VALUES (${userId}::uuid, ${accountName}, ${merged.keys[i]}, ${JSON.stringify(cells)}::jsonb)
          ON CONFLICT (user_id, account_name, dedupe_key)
          DO UPDATE SET cells = EXCLUDED.cells, created_at = now()
        `,
      );

      if (inserts.length === 0) {
        await sql`
          DELETE FROM reconciliation_csv_rows
          WHERE user_id = ${userId} AND account_name = ${accountName}
        `;
        return NextResponse.json({ success: true, rows: [], count: 0 });
      }

      for (let i = 0; i < inserts.length; i += CSV_SAVE_CHUNK_SIZE) {
        const chunk = inserts.slice(i, i + CSV_SAVE_CHUNK_SIZE);
        const isFirst = i === 0;
        await sql.transaction(
          isFirst
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

      return NextResponse.json({ success: true, rows: merged.rows, count: merged.rows.length });
    }

    // --- Legacy append mode: occurrence-indexed full-row keys (kept for the
    // one-time localStorage migration path). ---
    const validRows: Array<{ key: string; cells: string[] }> = [];
    const occurrenceCount = new Map<string, number>();
    for (const cells of incoming) {
      const base = csvRowDedupeKey(cells);
      const n = occurrenceCount.get(base) ?? 0;
      occurrenceCount.set(base, n + 1);
      const key = n === 0 ? base : `${base}|${n}`;
      validRows.push({ key, cells });
    }

    if (validRows.length === 0) {
      return NextResponse.json({ success: true, count: 0 });
    }

    await sql.transaction(
      validRows.map((r) =>
        sql`
          INSERT INTO reconciliation_csv_rows (user_id, account_name, dedupe_key, cells)
          VALUES (${userId}::uuid, ${accountName}, ${r.key}, ${JSON.stringify(r.cells)}::jsonb)
          ON CONFLICT (user_id, account_name, dedupe_key)
          DO UPDATE SET cells = EXCLUDED.cells, created_at = now()
        `,
      ),
    );

    return NextResponse.json({ success: true, count: validRows.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save CSV rows" },
      { status: 502 },
    );
  }
}
