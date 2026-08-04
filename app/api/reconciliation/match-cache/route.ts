import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

type MatchCacheRow = {
  account_name: string;
  bank_hash: string;
  match_data: unknown;
};

// Match types considered "completed" — only these get filtered by `?since=`.
// Actionable types (suggested_match, unmatched, questionable_match_fuzzy, transfer)
// are always returned regardless of date so the user never loses a pending row.
const COMPLETED_MATCH_TYPES = ["exact_match", "processed"];

function parseSinceParam(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const d = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return trimmed;
}

export async function GET(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  const since = parseSinceParam(request.nextUrl.searchParams.get("since"));

  try {
    const rows = since
      ? ((await sql`
          SELECT account_name, bank_hash, match_data
          FROM reconciliation_match_cache
          WHERE user_id = ${userId}
            AND (
              (match_data->>'matchType') NOT IN ('exact_match', 'processed')
              OR updated_at >= ${since}::timestamp
            )
          ORDER BY updated_at ASC
        `) as MatchCacheRow[])
      : ((await sql`
          SELECT account_name, bank_hash, match_data
          FROM reconciliation_match_cache
          WHERE user_id = ${userId}
          ORDER BY updated_at ASC
        `) as MatchCacheRow[]);

    const matchesByAccount: Record<string, unknown[]> = {};
    for (const row of rows) {
      const account = String(row.account_name ?? "").trim();
      if (!account) continue;
      if (!matchesByAccount[account]) matchesByAccount[account] = [];
      const matchData = row.match_data as Record<string, any>;
      if (matchData?.bankTransaction && typeof matchData.bankTransaction === "object") {
        matchData.bankTransaction.accountName = account;
      }
      matchesByAccount[account].push(matchData);
    }

    return NextResponse.json({
      matchesByAccount,
      since: since ?? null,
      completedMatchTypes: COMPLETED_MATCH_TYPES,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch match cache" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { accountName?: unknown; matches?: unknown; replace?: unknown };
  try {
    body = (await request.json()) as { accountName?: unknown; matches?: unknown; replace?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }
  if (!Array.isArray(body.matches)) {
    return NextResponse.json({ error: "matches must be an array" }, { status: 400 });
  }

  const replaceMode = body.replace === true;

  type MatchLike = { bankTransaction?: { hash?: string } };
  const validMatches: Array<{ hash: string; data: string }> = [];
  for (const match of body.matches) {
    const m = match as MatchLike;
    const hash = typeof m?.bankTransaction?.hash === "string" ? m.bankTransaction.hash.trim() : "";
    if (!hash) continue;
    validMatches.push({ hash, data: JSON.stringify(match) });
  }

  if (validMatches.length === 0 && !replaceMode) {
    return NextResponse.json({ success: true, count: 0 });
  }

  try {
    if (replaceMode) {
      await sql`
        DELETE FROM reconciliation_match_cache
        WHERE user_id = ${userId} AND account_name = ${accountName}
      `;
    }

    // One INSERT per row inside a single transaction. Bulk unnest(..., jsonb[])
    // is unreliable with Neon's HTTP driver / large JSON payloads; per-row params avoid that.
    if (validMatches.length > 0) {
      await sql.transaction(
        validMatches.map((m) =>
          sql`
            INSERT INTO reconciliation_match_cache (user_id, account_name, bank_hash, match_data)
            VALUES (${userId}::uuid, ${accountName}, ${m.hash}, ${m.data}::jsonb)
            ON CONFLICT (user_id, account_name, bank_hash)
            DO UPDATE SET match_data = EXCLUDED.match_data, updated_at = now()
          `,
        ),
      );
    }

    return NextResponse.json({ success: true, count: validMatches.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save match cache" },
      { status: 502 },
    );
  }
}
