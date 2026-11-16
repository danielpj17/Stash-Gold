import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Merchants and their filing rules, for /rules. Session only, scope-keyed.
 *
 * POST { mergeFrom, mergeInto } merges two merchants in ONE transaction:
 * repoint the aliases, repoint transactions.merchant_id, delete the source.
 * Every statement filters on user_id — including the DELETE (invariant 1).
 */
export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    const [merchants, aliases] = await Promise.all([
      sql`
        SELECT m.id, m.display_name, m.mode, m.category, m.shortlist, m.default_category,
               m.created_at, m.last_seen_at,
               (SELECT count(*)::int FROM transactions t
                 WHERE t.user_id = m.user_id AND t.merchant_id = m.id) AS tx_count
          FROM merchants m
         WHERE m.user_id = ${userId}
         ORDER BY m.last_seen_at DESC NULLS LAST, m.display_name ASC
      ` as unknown as Promise<Array<Record<string, unknown>>>,
      sql`
        SELECT normalized_key, merchant_id, example_raw, last_seen_at, key_version
          FROM merchant_aliases WHERE user_id = ${userId}
         ORDER BY last_seen_at DESC NULLS LAST
      ` as unknown as Promise<Array<Record<string, unknown>>>,
    ]);

    const byMerchant = new Map<string, Array<Record<string, unknown>>>();
    for (const a of aliases) {
      const key = String(a.merchant_id);
      if (!byMerchant.has(key)) byMerchant.set(key, []);
      byMerchant.get(key)!.push({
        key: a.normalized_key,
        exampleRaw: a.example_raw,
        lastSeenAt: a.last_seen_at,
        keyVersion: a.key_version,
      });
    }

    return NextResponse.json({
      merchants: merchants.map((m) => ({
        id: m.id,
        displayName: m.display_name,
        mode: m.mode,
        category: m.category,
        shortlist: Array.isArray(m.shortlist) ? m.shortlist : [],
        defaultCategory: m.default_category,
        createdAt: m.created_at,
        lastSeenAt: m.last_seen_at,
        transactionCount: Number(m.tx_count ?? 0),
        aliases: byMerchant.get(String(m.id)) ?? [],
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load merchants" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const from = typeof body.mergeFrom === "string" ? body.mergeFrom : "";
  const into = typeof body.mergeInto === "string" ? body.mergeInto : "";
  if (!from || !into || from === into) {
    return NextResponse.json({ error: "mergeFrom and mergeInto must be two different merchants" }, { status: 400 });
  }

  try {
    const both = (await sql`
      SELECT id FROM merchants WHERE user_id = ${userId} AND id = ANY(${[from, into]}::uuid[])
    `) as Array<{ id: string }>;
    if (both.length !== 2) return NextResponse.json({ error: "Merchant not found" }, { status: 404 });

    await sql.transaction([
      sql`
        UPDATE merchant_aliases SET merchant_id = ${into}::uuid
         WHERE user_id = ${userId} AND merchant_id = ${from}::uuid
      `,
      sql`
        UPDATE transactions SET merchant_id = ${into}::uuid
         WHERE user_id = ${userId} AND merchant_id = ${from}::uuid
      `,
      sql`DELETE FROM merchants WHERE user_id = ${userId} AND id = ${from}::uuid`,
    ]);
    return NextResponse.json({ merged: true, into });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to merge" },
      { status: 502 },
    );
  }
}

/**
 * Move a raw name (alias) to another merchant: { key, merchantId } — or
 * { key, split: true } to give it a merchant of its own. Past transactions
 * stay with the merchant they were filed under.
 */
export async function PATCH(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key : "";
  if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });

  try {
    const alias = (await sql`
      SELECT merchant_id, example_raw FROM merchant_aliases WHERE user_id = ${userId} AND normalized_key = ${key}
    `) as Array<{ merchant_id: string; example_raw: string }>;
    if (!alias[0]) return NextResponse.json({ error: "Raw name not found" }, { status: 404 });

    if (body.split === true) {
      const created = (await sql`
        INSERT INTO merchants (user_id, display_name, mode)
        VALUES (${userId}::uuid, ${alias[0].example_raw.slice(0, 80)}, 'ask_all')
        RETURNING id
      `) as Array<{ id: string }>;
      await sql`
        UPDATE merchant_aliases SET merchant_id = ${created[0].id}::uuid
         WHERE user_id = ${userId} AND normalized_key = ${key}
      `;
      return NextResponse.json({ moved: true, merchantId: created[0].id });
    }

    const target = typeof body.merchantId === "string" ? body.merchantId : "";
    const exists = (await sql`
      SELECT 1 FROM merchants WHERE user_id = ${userId} AND id = ${target}::uuid
    `) as unknown[];
    if (exists.length === 0) return NextResponse.json({ error: "Merchant not found" }, { status: 404 });

    await sql.transaction([
      sql`
        UPDATE merchant_aliases SET merchant_id = ${target}::uuid
         WHERE user_id = ${userId} AND normalized_key = ${key}
      `,
      // A merchant left with no raw names would never match again.
      sql`
        DELETE FROM merchants m
         WHERE m.user_id = ${userId} AND m.id = ${alias[0].merchant_id}::uuid
           AND NOT EXISTS (SELECT 1 FROM merchant_aliases a WHERE a.user_id = m.user_id AND a.merchant_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = m.user_id AND t.merchant_id = m.id)
      `,
    ]);
    return NextResponse.json({ moved: true, merchantId: target });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to move" },
      { status: 502 },
    );
  }
}
