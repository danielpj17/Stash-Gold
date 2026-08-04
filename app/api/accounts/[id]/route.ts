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
 * Delete an account and everything reconciliation-related that references it.
 *
 * Requires ?force=true when the account still has reconciliation state, so a
 * misclick can't silently discard months of matching. Archiving (isActive:false)
 * is the non-destructive alternative.
 */
export async function DELETE(request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  const accountId = String(context.params.id ?? "").trim();
  if (!accountId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  const force = request.nextUrl.searchParams.get("force") === "true";

  try {
    const existing = await getAccount(sql, userId, accountId);
    if (!existing) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    const counts = (await sql`
      SELECT
        (SELECT count(*) FROM reconciliation_csv_rows
          WHERE user_id = ${userId} AND account_name = ${accountId}) AS csv_rows,
        (SELECT count(*) FROM reconciliation_claim_links
          WHERE user_id = ${userId} AND account_name = ${accountId}) AS claims
    `) as Array<{ csv_rows: string; claims: string }>;
    const stateCount = Number(counts[0]?.csv_rows ?? 0) + Number(counts[0]?.claims ?? 0);

    if (stateCount > 0 && !force) {
      return NextResponse.json(
        {
          error: "This account still has reconciliation data.",
          requiresForce: true,
          stateCount,
        },
        { status: 409 },
      );
    }

    await sql.transaction([
      sql`DELETE FROM reconciliation_csv_rows WHERE user_id = ${userId} AND account_name = ${accountId}`,
      sql`DELETE FROM reconciliation_match_cache WHERE user_id = ${userId} AND account_name = ${accountId}`,
      sql`DELETE FROM reconciliation_uploaded_files WHERE user_id = ${userId} AND account_name = ${accountId}`,
      sql`DELETE FROM reconciliation_claim_links WHERE user_id = ${userId} AND account_name = ${accountId}`,
      sql`DELETE FROM reconciliation_statement_dismissals WHERE user_id = ${userId} AND account_name = ${accountId}`,
      sql`DELETE FROM reconciliation_transfer_claim_links WHERE user_id = ${userId} AND bank_account_name = ${accountId}`,
      sql`DELETE FROM processed_transactions WHERE user_id = ${userId} AND account_name = ${accountId}`,
      sql`DELETE FROM reconciliation_merchant_memory WHERE user_id = ${userId} AND bank_account_name = ${accountId}`,
      sql`DELETE FROM account_anchors WHERE user_id = ${userId} AND account_name = ${accountId}`,
      // account_csv_profiles cascades from financial_accounts.
      sql`DELETE FROM financial_accounts WHERE user_id = ${userId} AND id = ${accountId}::uuid`,
    ]);

    return NextResponse.json({ success: true, accounts: await listAccounts(sql, userId) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete account" },
      { status: 502 },
    );
  }
}
