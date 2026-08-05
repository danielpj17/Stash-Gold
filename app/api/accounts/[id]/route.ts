import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { getAccount, listAccounts, normalizeAccountKind } from "@/lib/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toNullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Update an account and/or its CSV parsing profile.
 *
 * `name` is display-only — the account's UUID is what every reconciliation row
 * references — so renaming is always safe and never orphans anything.
 */
export async function PATCH(request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  const accountId = String(context.params.id ?? "").trim();
  if (!accountId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  let body: {
    name?: unknown;
    kind?: unknown;
    openingBalance?: unknown;
    isActive?: unknown;
    isDefault?: unknown;
    csvProfile?: Record<string, unknown> | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const existing = await getAccount(sql, userId, accountId);
    if (!existing) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : existing.name;
    if (!name) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    const kind = body.kind === undefined ? existing.kind : normalizeAccountKind(body.kind);
    const openingBalance =
      body.openingBalance === undefined ? existing.openingBalance : Number(body.openingBalance);
    if (!Number.isFinite(openingBalance)) {
      return NextResponse.json({ error: "openingBalance must be numeric" }, { status: 400 });
    }
    const isActive = body.isActive === undefined ? existing.isActive : body.isActive !== false;

    await sql`
      UPDATE financial_accounts
         SET name = ${name},
             kind = ${kind},
             opening_balance = ${openingBalance},
             is_active = ${isActive}
       WHERE user_id = ${userId} AND id = ${accountId}::uuid
    `;

    // Only one default per user (enforced by a partial unique index), so clear
    // the old one in the same transaction as setting the new one.
    if (body.isDefault === true) {
      await sql.transaction([
        sql`
          UPDATE financial_accounts SET is_default = false
           WHERE user_id = ${userId} AND is_default AND id <> ${accountId}::uuid
        `,
        sql`
          UPDATE financial_accounts SET is_default = true
           WHERE user_id = ${userId} AND id = ${accountId}::uuid AND deleted_at IS NULL
        `,
      ]);
    }

    if (body.csvProfile !== undefined) {
      if (body.csvProfile === null) {
        await sql`
          DELETE FROM account_csv_profiles
          WHERE user_id = ${userId} AND account_id = ${accountId}::uuid
        `;
      } else {
        const p = body.csvProfile;
        const dateIndex = toNullableInt(p.dateIndex);
        const descriptionIndex = toNullableInt(p.descriptionIndex);
        const amountIndex = toNullableInt(p.amountIndex);
        const debitIndex = toNullableInt(p.debitIndex);
        const creditIndex = toNullableInt(p.creditIndex);

        // Reject a mapping the parser could never use, rather than storing one
        // that silently yields zero transactions on every upload.
        const usableAmount = amountIndex !== null || (debitIndex !== null && creditIndex !== null);
        if (dateIndex === null || descriptionIndex === null || !usableAmount) {
          return NextResponse.json(
            {
              error:
                "A CSV mapping needs a date column, a description column, and either an amount column or both debit and credit columns.",
            },
            { status: 400 },
          );
        }

        await sql`
          INSERT INTO account_csv_profiles (
            account_id, user_id, has_header, header_row_index,
            date_index, amount_index, description_index, debit_index, credit_index,
            outflow_is_positive, derive_date_from_description,
            detected_automatically, sample_headers, updated_at
          )
          VALUES (
            ${accountId}::uuid, ${userId}::uuid,
            ${p.hasHeader !== false}, ${toNullableInt(p.headerRowIndex) ?? 0},
            ${dateIndex}, ${amountIndex}, ${descriptionIndex}, ${debitIndex}, ${creditIndex},
            ${p.outflowIsPositive === true}, ${p.deriveDateFromDescription === true},
            ${p.detectedAutomatically === true},
            ${JSON.stringify(Array.isArray(p.sampleHeaders) ? p.sampleHeaders : [])}::jsonb,
            now()
          )
          ON CONFLICT (account_id) DO UPDATE SET
            has_header = EXCLUDED.has_header,
            header_row_index = EXCLUDED.header_row_index,
            date_index = EXCLUDED.date_index,
            amount_index = EXCLUDED.amount_index,
            description_index = EXCLUDED.description_index,
            debit_index = EXCLUDED.debit_index,
            credit_index = EXCLUDED.credit_index,
            outflow_is_positive = EXCLUDED.outflow_is_positive,
            derive_date_from_description = EXCLUDED.derive_date_from_description,
            detected_automatically = EXCLUDED.detected_automatically,
            sample_headers = EXCLUDED.sample_headers,
            updated_at = now()
        `;

        // A changed mapping produces different hashes, so cached match results
        // for this account are meaningless. Drop them; the user re-uploads or
        // re-matches to rebuild.
        await sql`
          DELETE FROM reconciliation_match_cache
          WHERE user_id = ${userId} AND account_name = ${accountId}
        `;
      }
    }

    const accounts = await listAccounts(sql, userId);
    return NextResponse.json({
      account: accounts.find((a) => a.id === accountId) ?? null,
      accounts,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update account";
    const isConflict = message.toLowerCase().includes("unique");
    return NextResponse.json(
      { error: isConflict ? "You already have an account with that name." : message },
      { status: isConflict ? 409 : 502 },
    );
  }
}

/**
 * Delete an account — SOFT.
 *
 * Reconciliation history references accounts by id: claim links, processed
 * hashes, dismissals, the match cache, anchors and merchant memory all carry
 * the account id in `account_name`. Hard-deleting the row would leave all of
 * that intact but unable to resolve a name, so past matches would render as
 * raw UUIDs — and deleting the history instead would silently throw away
 * months of reconciling.
 *
 * So the row stays, flagged deleted. It vanishes from every picker and list,
 * while everything ever matched against it stays matched and correctly labeled.
 * Transactions that referenced it keep their history too; they simply stop
 * contributing to any balance, because the account is no longer in the live
 * set that `computeAccountBalances` seeds from.
 */
export async function DELETE(_request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  const accountId = String(context.params.id ?? "").trim();
  if (!accountId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const existing = await getAccount(sql, userId, accountId);
    if (!existing) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    if (existing.isDeleted) {
      return NextResponse.json({ success: true, accounts: await listAccounts(sql, userId) });
    }

    await sql.transaction([
      sql`
        UPDATE financial_accounts
           SET deleted_at = now(), is_active = false, is_default = false
         WHERE user_id = ${userId} AND id = ${accountId}::uuid
      `,
      // If this was the default, promote the oldest remaining live account so
      // Shortcut-logged expenses still have somewhere to land.
      sql`
        UPDATE financial_accounts
           SET is_default = true
         WHERE id = (
           SELECT id FROM financial_accounts
            WHERE user_id = ${userId}::uuid
              AND deleted_at IS NULL
              AND id <> ${accountId}::uuid
            ORDER BY sort_order ASC, created_at ASC
            LIMIT 1
         )
           AND NOT EXISTS (
             SELECT 1 FROM financial_accounts
              WHERE user_id = ${userId}::uuid AND is_default AND deleted_at IS NULL
           )
      `,
    ]);

    return NextResponse.json({ success: true, accounts: await listAccounts(sql, userId) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete account" },
      { status: 502 },
    );
  }
}
