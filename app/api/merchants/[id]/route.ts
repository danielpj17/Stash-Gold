import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { isExpenseCategory } from "@/lib/email/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Edit one merchant's rule: { displayName?, mode?, category?, shortlist?, defaultCategory? }.
 *
 * Rule changes NEVER touch past rows. Re-filing history is a separate,
 * explicit step (POST, below) that shows a count first.
 */
export async function PATCH(request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;
  const id = String(context.params.id ?? "");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const rows = (await sql`
      SELECT display_name, mode, category, shortlist, default_category
        FROM merchants WHERE user_id = ${userId} AND id = ${id}::uuid
    `) as Array<{ display_name: string; mode: string; category: string | null; shortlist: string[]; default_category: string | null }>;
    const m = rows[0];
    if (!m) return NextResponse.json({ error: "Merchant not found" }, { status: 404 });

    const displayName =
      typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim().slice(0, 80) : m.display_name;
    const mode =
      body.mode === "auto" || body.mode === "ask_shortlist" || body.mode === "ask_all" || body.mode === "skip"
        ? body.mode
        : m.mode;
    const pick = (value: unknown, fallback: string | null) =>
      value === undefined ? fallback : value === null || value === "" ? null : isExpenseCategory(value) ? value : undefined;
    const category = pick(body.category, m.category);
    const defaultCategory = pick(body.defaultCategory, m.default_category);
    if (category === undefined || defaultCategory === undefined) {
      return NextResponse.json({ error: "Unknown category" }, { status: 400 });
    }
    const shortlist = Array.isArray(body.shortlist)
      ? [...new Set(body.shortlist.filter(isExpenseCategory))]
      : m.shortlist ?? [];

    if (mode === "auto" && !category) {
      return NextResponse.json({ error: "An automatic rule needs a category" }, { status: 400 });
    }
    if (mode === "ask_shortlist" && shortlist.length === 0) {
      return NextResponse.json({ error: "A shortlist needs at least one category" }, { status: 400 });
    }

    await sql`
      UPDATE merchants
         SET display_name = ${displayName}, mode = ${mode}, category = ${category},
             shortlist = ${shortlist}::text[], default_category = ${defaultCategory}
       WHERE user_id = ${userId} AND id = ${id}::uuid
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 502 },
    );
  }
}

/**
 * "Apply to past transactions" (plan §5.5).
 *
 * GET ?category=X previews: how many rows would change, and how many of
 * those a PERSON filed as something else ("3 of them you filed as Dates").
 * POST { category } re-files them in one statement scoped on user_id AND
 * merchant_id. Expenses only; nothing's amount or claim changes.
 */
export async function GET(request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;
  const id = String(context.params.id ?? "");
  const category = request.nextUrl.searchParams.get("category") ?? "";
  if (!isExpenseCategory(category)) return NextResponse.json({ error: "Unknown category" }, { status: 400 });

  try {
    const rows = (await sql`
      SELECT category, categorized_by, count(*)::int AS n
        FROM transactions
       WHERE user_id = ${userId} AND merchant_id = ${id}::uuid AND kind = 'expense'
         AND category IS DISTINCT FROM ${category}
       GROUP BY 1, 2
    `) as Array<{ category: string | null; categorized_by: string | null; n: number }>;
    const total = rows.reduce((s, r) => s + Number(r.n), 0);
    const personFiled = rows
      .filter((r) => r.categorized_by === "user" || r.categorized_by === null)
      .filter((r) => r.category)
      .map((r) => ({ category: r.category as string, count: Number(r.n) }));
    return NextResponse.json({ total, personFiled });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 502 });
  }
}

export async function POST(request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId, actorId } = ctx;
  const id = String(context.params.id ?? "");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isExpenseCategory(body.category)) return NextResponse.json({ error: "Unknown category" }, { status: 400 });

  try {
    const rows = (await sql`
      UPDATE transactions
         SET category = ${body.category},
             categorized_by = 'user',
             review_status = 'confirmed',
             reviewed_by = ${actorId}::uuid,
             reviewed_at = now(),
             updated_at = now()
       WHERE user_id = ${userId} AND merchant_id = ${id}::uuid AND kind = 'expense'
         AND (category IS DISTINCT FROM ${body.category} OR review_status = 'needs_review')
      RETURNING id
    `) as Array<{ id: string }>;
    return NextResponse.json({ updated: rows.length });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 502 });
  }
}
