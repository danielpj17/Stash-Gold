import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { listAccounts, normalizeAccountKind } from "@/lib/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  try {
    return NextResponse.json({ accounts: await listAccounts(sql, userId) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load accounts" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { name?: unknown; kind?: unknown; openingBalance?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  // Reserved: these are the "money left the tracked set" labels transfers use.
  if (["cash", "parents", "misc.", "other"].includes(name.toLowerCase())) {
    return NextResponse.json(
      { error: `"${name}" is reserved for transfers in and out of your accounts.` },
      { status: 400 },
    );
  }
  if (name.length > 60) {
    return NextResponse.json({ error: "name must be 60 characters or fewer" }, { status: 400 });
  }

  const kind = normalizeAccountKind(body.kind);
  const openingBalance = Number(body.openingBalance ?? 0);
  if (!Number.isFinite(openingBalance)) {
    return NextResponse.json({ error: "openingBalance must be numeric" }, { status: 400 });
  }

  try {
    const rows = (await sql`
      INSERT INTO financial_accounts (user_id, name, kind, opening_balance, sort_order, is_default)
      VALUES (
        ${userId}::uuid,
        ${name},
        ${kind},
        ${openingBalance},
        COALESCE(
          (SELECT MAX(sort_order) + 1 FROM financial_accounts WHERE user_id = ${userId}::uuid),
          0
        ),
        -- The first account a user creates becomes their default, so expenses
        -- logged without an account (the iOS Shortcut) have somewhere to go.
        NOT EXISTS (
          SELECT 1 FROM financial_accounts
          WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
        )
      )
      RETURNING id
    `) as Array<{ id: string }>;

    const accounts = await listAccounts(sql, userId);
    return NextResponse.json(
      { account: accounts.find((a) => a.id === rows[0]?.id) ?? null, accounts },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create account";
    const isConflict = message.toLowerCase().includes("unique");
    return NextResponse.json(
      { error: isConflict ? `You already have an account named "${name}".` : message },
      { status: isConflict ? 409 : 502 },
    );
  }
}

/**
 * Reorder accounts: `{ order: string[] }`, the ids in their new order.
 *
 * `sort_order` already governs every list in the app — `listAccounts` sorts on
 * it, and the pickers, the reconcile dropdown, Statement Accounts and the iOS
 * Shortcut's picker (`/api/ingest/accounts`) all map straight over that result.
 * The column and its index existed from the first schema; nothing could ever
 * write to it. This is that missing half.
 *
 * Positions are assigned from the array, so the caller sends the COMPLETE order
 * it is showing. An id it omits keeps whatever it had, which is what makes
 * soft-deleted accounts (invisible in the modal) harmless to leave out.
 */
export async function PATCH(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  let body: { order?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.order)) {
    return NextResponse.json({ error: "order must be an array of account ids" }, { status: 400 });
  }

  const ids = body.order.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ error: "order must contain at least one account id" }, { status: 400 });
  }
  if (new Set(ids).size !== ids.length) {
    return NextResponse.json({ error: "order contains a duplicate account id" }, { status: 400 });
  }

  try {
    // One statement, so a reorder is atomic — a half-applied order would leave
    // duplicate positions and an arbitrary list. `user_id` in the WHERE is what
    // makes an id from another scope a no-op rather than a cross-user write.
    const positions = ids.map((_id, index) => index);
    await sql`
      UPDATE financial_accounts AS a
      SET sort_order = o.position
      FROM unnest(${ids}::uuid[], ${positions}::int[]) AS o(id, position)
      WHERE a.user_id = ${userId}::uuid AND a.id = o.id
    `;

    return NextResponse.json({ accounts: await listAccounts(sql, userId) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reorder accounts" },
      { status: 502 },
    );
  }
}
