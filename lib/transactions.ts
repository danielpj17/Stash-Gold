import { randomUUID } from "crypto";
import { getDefaultAccountId } from "@/lib/accounts";
import type { Sql } from "@/lib/db";
import { EMAIL_SYNC_CONFIG } from "@/lib/email/config";
import { loadScopeTimezone } from "@/lib/email/context";
import { amountsCompatible } from "@/lib/email/decide";
import { localDate } from "@/lib/email/occurredAt";
import { isEmailSyncLive } from "@/lib/email/settings";

export type TransactionKind = "expense" | "income" | "transfer";

/**
 * Who created a row. 'email' rows come only from lib/email/apply.ts; the web
 * form writes 'manual' and the iOS Shortcut 'shortcut'. The Shortcut's
 * per-minute rate guard counts only its own rows, so an email burst after an
 * outage can't 429 it.
 */
export type TransactionSource = "manual" | "shortcut" | "csv";

export type TransactionInput = {
  kind: TransactionKind;
  /** ISO instant. Defaults to now when the caller sends no date. */
  occurredAt: string;
  amount: number;
  /** expense/income: the "Expense Type", VERBATIM — including the literal 'Income'. */
  category: string | null;
  description: string;
  /** expense/income: financial_accounts.id (or an external label). */
  account: string | null;
  transferFrom: string | null;
  transferTo: string | null;
};

/** Camel-cased row shaped exactly like the client's SheetRow / TransferRow. */
export type TransactionRow = Record<string, unknown>;

function readField(body: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null) return body[key];
  }
  const normalized = new Map<string, unknown>();
  for (const [k, v] of Object.entries(body)) {
    normalized.set(k.trim().toLowerCase(), v);
  }
  for (const key of keys) {
    const value = normalized.get(key.trim().toLowerCase());
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function readString(body: Record<string, unknown>, keys: string[]): string {
  const value = readField(body, keys);
  return typeof value === "string" ? value.trim() : value === undefined ? "" : String(value).trim();
}

/**
 * Resolve a caller-supplied date to an ISO instant.
 *
 * A bare `YYYY-MM-DD` is anchored at midday UTC rather than midnight: midnight
 * lands on the previous calendar day for every timezone west of UTC, which
 * would silently shift a transaction into the wrong month.
 */
function resolveOccurredAt(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return new Date().toISOString();
  const value = String(raw).trim();
  if (!value) return new Date().toISOString();

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Normalize a request body into a TransactionInput.
 *
 * Accepts both the app's own shape and the looser aliases the existing iOS
 * Shortcut sends (`Expense Type`, `type`, `notes`, `sheet: "Transfers"`), so
 * that Shortcut needs only a new URL and an Authorization header — not a
 * rebuilt body.
 */
export function parseTransactionInput(raw: unknown): TransactionInput | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  const kindRaw = readString(body, ["kind"]).toLowerCase();
  const sheetRaw = readString(body, ["sheet"]).toLowerCase();
  const isTransfer =
    kindRaw === "transfer" ||
    sheetRaw === "transfers" ||
    (readString(body, ["transferFrom", "Transfer from", "Transfer From"]) !== "" &&
      readString(body, ["transferTo", "Transfer To"]) !== "");

  const amountRaw = readField(body, ["amount", "Amount", "Transfer Amount"]);
  const amount = Number(typeof amountRaw === "string" ? amountRaw.replace(/[$,\s]/g, "") : amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "amount must be a positive number" };
  }

  const occurredAt = resolveOccurredAt(readField(body, ["date", "Date", "occurredAt", "timestamp"]));
  if (!occurredAt) return { error: "date could not be understood" };

  const description = readString(body, ["description", "Description", "notes", "note", "memo"]);

  if (isTransfer) {
    const transferFrom = readString(body, ["transferFrom", "Transfer from", "Transfer From", "from"]);
    const transferTo = readString(body, ["transferTo", "Transfer To", "to"]);
    if (!transferFrom || !transferTo) {
      return { error: "transferFrom and transferTo are required for a transfer" };
    }
    return {
      kind: "transfer",
      occurredAt,
      amount,
      category: null,
      description,
      account: null,
      transferFrom,
      transferTo,
    };
  }

  const category = readString(body, ["expenseType", "Expense Type", "expense type", "type", "category"]);
  if (!category) return { error: "expenseType is required" };

  return {
    // `category` keeps the literal 'Income' string because several call sites
    // branch on it; `kind` is the convenient discriminator.
    kind: category.trim().toLowerCase() === "income" ? "income" : "expense",
    occurredAt,
    amount,
    category,
    description,
    account: readString(body, ["account", "Account", "accountId"]) || null,
    transferFrom: null,
    transferTo: null,
  };
}

/**
 * Joins every SELECT below needs.
 *
 * `u` is the SCOPE owner — its timezone derives each row's local date and
 * month, so a shared household gets one consistent month boundary rather than
 * two competing ones.
 *
 * `eb` is whoever entered the row. LEFT, because `entered_by` is nullable
 * (a since-removed member, or a row from before attribution existed) and an
 * inner join would silently drop those transactions from every list in the app.
 */
export const TRANSACTION_JOINS = `
  JOIN users u ON u.id = t.user_id
  LEFT JOIN users eb ON eb.id = t.entered_by
`;

/**
 * `enteredByName` is display-only, and NULL in the two cases where there is
 * nothing worth saying:
 *
 *   1. Nobody shares this scope. A solo Stash must look exactly as it did
 *      before this feature existed, so the EXISTS gate suppresses the field
 *      entirely rather than relying on `users.name` happening to be unset —
 *      which would leak a name back onto every row if a household is ever
 *      un-shared.
 *   2. That person never set a name. No fallback to the email local-part:
 *      a guessed name is worse than no name.
 *
 * The subquery is correlated on the scope, so in the worst case it runs per
 * row — but it is an index-only probe of `idx_users_data_owner`, a partial
 * index holding one row per shared household.
 */
const ENTERED_BY_FIELD = `
  CASE WHEN EXISTS (SELECT 1 FROM users m WHERE m.data_owner_id = u.id)
       THEN NULLIF(eb.name, '')
  END                                                              AS "enteredByName"`;

/**
 * Email-sync fields (plan §5.8). ADDITIVE: existing consumers and the match
 * cache JSON ignore them. `reviewStatus` + `categorizedBy` are what every
 * category display uses for the "unconfirmed" marker (D2): a row whose
 * category no person chose is `needs_review`, or `categorizedBy = 'guess'`.
 */
const EMAIL_SYNC_FIELDS = `
  t.source                                                         AS "source",
  t.review_status                                                  AS "reviewStatus",
  t.categorized_by                                                 AS "categorizedBy",
  t.is_pending                                                     AS "isPending",
  t.original_amount                                                AS "originalAmount",
  t.auto_merged                                                    AS "autoMerged",
  t.duplicate_of                                                   AS "duplicateOf",`;

/** Columns aliased to the exact camelCase field names the client expects. */
export const EXPENSE_SELECT_FIELDS = `
${EMAIL_SYNC_FIELDS}
  t.id                                                             AS "rowId",
  to_char(t.occurred_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')                         AS "timestamp",
  to_char(t.occurred_at AT TIME ZONE u.timezone, 'YYYY-MM-DD')     AS "date",
  t.category                                                       AS "expenseType",
  t.amount                                                         AS "amount",
  t.description                                                    AS "description",
  to_char(t.occurred_at AT TIME ZONE u.timezone, 'FMMM')           AS "month",
  t.account                                                        AS "account",
${ENTERED_BY_FIELD}
`;

export const TRANSFER_SELECT_FIELDS = `
  t.source                                                         AS "source",
  t.review_status                                                  AS "reviewStatus",
  t.duplicate_of                                                   AS "duplicateOf",
  t.id                                                             AS "transferRowId",
  to_char(t.occurred_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')                         AS "timestamp",
  to_char(t.occurred_at AT TIME ZONE u.timezone, 'YYYY-MM-DD')     AS "date",
  t.transfer_from                                                  AS "transferFrom",
  t.transfer_to                                                    AS "transferTo",
  t.amount                                                         AS "amount",
  t.description                                                    AS "description",
  to_char(t.occurred_at AT TIME ZONE u.timezone, 'FMMM')           AS "month",
${ENTERED_BY_FIELD}
`;

/**
 * `date` is a real behavioural fork: it used to be undefined for every row, and
 * the matcher prefers `date ?? timestamp`. Emitting a true local date is more
 * correct (it fixes an evening off-by-one) but it changes date-distance scoring
 * and therefore which rows auto-match. Set TRANSACTIONS_EMIT_DATE=false to fall
 * back to the old behaviour without a code change.
 */
export function shouldEmitDate(): boolean {
  return process.env.TRANSACTIONS_EMIT_DATE !== "false";
}

export function stripDateIfDisabled(row: TransactionRow): TransactionRow {
  if (shouldEmitDate()) return row;
  const { date: _date, ...rest } = row;
  return rest;
}

/**
 * @param userId  The data scope this row belongs to (the household owner).
 * @param actorId Who is logging it. Same as `userId` for a solo user; the
 *                signed-in spouse, or the owner of the ingest token, otherwise.
 *                Recorded for display and never used to filter.
 */
export async function insertTransaction(
  sql: Sql,
  userId: string,
  input: TransactionInput,
  actorId: string,
  opts: { source?: TransactionSource; duplicateOf?: string | null } = {},
): Promise<TransactionRow> {
  const id = randomUUID();

  // An expense with no account contributes to budgets and totals but moves no
  // balance, which is a silent surprise. The iOS Shortcut can't reasonably send
  // a UUID, so fall back to the user's default account.
  const account =
    input.kind === "transfer" ? null : input.account ?? (await getDefaultAccountId(sql, userId));

  await sql`
    INSERT INTO transactions (
      id, user_id, entered_by, kind, occurred_at, amount,
      category, description, account, transfer_from, transfer_to,
      source, duplicate_of
    )
    VALUES (
      ${id}, ${userId}::uuid, ${actorId}::uuid,
      ${input.kind}, ${input.occurredAt}::timestamptz, ${input.amount},
      ${input.category}, ${input.description}, ${account},
      ${input.transferFrom}, ${input.transferTo},
      ${opts.source ?? "manual"}, ${opts.duplicateOf ?? null}
    )
  `;

  return selectTransactionRow(sql, userId, id, input.kind);
}

export async function selectTransactionRow(
  sql: Sql,
  userId: string,
  id: string,
  kind: TransactionKind,
): Promise<TransactionRow> {
  const fields = kind === "transfer" ? TRANSFER_SELECT_FIELDS : EXPENSE_SELECT_FIELDS;
  const rows = (await sql(
    `SELECT ${fields}
     FROM transactions t
     ${TRANSACTION_JOINS}
     WHERE t.user_id = $1 AND t.id = $2`,
    [userId, id],
  )) as TransactionRow[];

  return stripDateIfDisabled(rows[0] ?? { rowId: id });
}

/** What the client needs to offer "Keep both instead?" after an absorb. */
export type AbsorbedEmail = {
  transactionId: string;
  /** The email row's description before the manual entry's replaced it. */
  previousDescription: string;
  merchantName: string | null;
};

export type InsertOrLinkResult = {
  row: TransactionRow;
  /** The manual entry answered a waiting email row instead of adding one (plan §5.7). */
  absorbed: AbsorbedEmail | null;
  /** Saved, but an already-confirmed email row looks like the same purchase. */
  possibleDuplicateOf: string | null;
};

type EmailCandidate = {
  id: string;
  kind: string;
  occurred_at: string | Date;
  amount: string | number;
  account: string | null;
  transfer_from: string | null;
  transfer_to: string | null;
  review_status: string;
  is_pending: boolean;
  description: string;
  merchant_id: string | null;
  merchant_name: string | null;
  claimed: boolean;
  /** The alert was a Venmo receipt: a PERSON, never given a default guess. */
  from_venmo: boolean;
};

/**
 * The manual-entry half of email dedupe (plan §5.7 "Manual entry saved AFTER
 * the alert"). Both write routes call this; `insertTransaction` stays a plain
 * insert.
 *
 * Runs only when this scope's email sync is LIVE. Kinds must match: an expense
 * pairs with an expense and income with income (so a hand-logged paycheck
 * isn't doubled by its deposit alert), and transfers with transfers (D4).
 *
 * Exactly one email row, ±2 days, same amount (or a tip/gas tolerance), on the
 * same account or with the manual entry on the default:
 *   - still needs_review → ABSORB: the manual entry IS the answer. No second
 *     row; the response offers "Keep both instead?".
 *   - already confirmed → save the manual row too, flagged as a possible
 *     duplicate for To categorize.
 */
export async function insertOrLinkTransaction(
  sql: Sql,
  userId: string,
  input: TransactionInput,
  actorId: string,
  opts: { source: TransactionSource; keepSeparate?: boolean },
): Promise<InsertOrLinkResult> {
  const plain = async (duplicateOf: string | null = null): Promise<InsertOrLinkResult> => ({
    row: await insertTransaction(sql, userId, input, actorId, { source: opts.source, duplicateOf }),
    absorbed: null,
    possibleDuplicateOf: duplicateOf,
  });
  if (opts.keepSeparate) return plain();

  let live = false;
  try {
    live = await isEmailSyncLive(sql, userId);
  } catch {
    live = false; // email sync not set up (migration 004 not applied): behave exactly as before
  }
  if (!live) return plain();

  const [rows, defaultAccountId, timeZone] = await Promise.all([
    sql`
      SELECT t.id, t.kind, t.occurred_at, t.amount, t.account, t.transfer_from, t.transfer_to,
             t.review_status, t.is_pending, t.description, t.merchant_id,
             m.display_name AS merchant_name,
             COALESCE((SELECT e.parser_id = 'venmo' FROM email_events e
                        WHERE e.user_id = t.user_id AND e.id = t.email_event_id), false) AS from_venmo,
             (
               EXISTS (SELECT 1 FROM reconciliation_claim_links c
                        WHERE c.user_id = t.user_id AND c.sheet_name = 'Expenses' AND c.sheet_row_id = t.id)
               OR EXISTS (SELECT 1 FROM reconciliation_transfer_claim_links tc
                           WHERE tc.user_id = t.user_id AND tc.transfer_sheet_row_id = t.id)
             ) AS claimed
        FROM transactions t
        LEFT JOIN merchants m ON m.user_id = t.user_id AND m.id = t.merchant_id
       WHERE t.user_id = ${userId}
         AND t.source = 'email'
         AND t.kind = ${input.kind}
         AND t.duplicate_of IS NULL
         AND t.occurred_at BETWEEN ${input.occurredAt}::timestamptz - interval '3 days'
                               AND ${input.occurredAt}::timestamptz + interval '3 days'
    ` as unknown as Promise<EmailCandidate[]>,
    input.kind === "transfer" ? Promise.resolve(null) : getDefaultAccountId(sql, userId),
    loadScopeTimezone(sql, userId),
  ]);

  const manualCents = Math.round(input.amount * 100);
  const manualAccount = input.kind === "transfer" ? null : input.account ?? defaultAccountId;
  const day = (iso: string | Date) =>
    Date.parse(`${localDate(new Date(iso).toISOString(), timeZone)}T00:00:00Z`);
  const manualDay = day(input.occurredAt);

  const matches = rows.filter((r) => {
    if (r.claimed) return false;
    if (Math.abs(day(r.occurred_at) - manualDay) / 86_400_000 > EMAIL_SYNC_CONFIG.manualMatchWindowDays) {
      return false;
    }
    const cents = Math.round(Number(r.amount) * 100);
    if (input.kind === "transfer") {
      const fromOk = r.transfer_from === null || r.transfer_from === input.transferFrom;
      const toOk = r.transfer_to === null || r.transfer_to === input.transferTo;
      return cents === manualCents && fromOk && toOk;
    }
    const accountOk =
      manualAccount === null || r.account === manualAccount || manualAccount === defaultAccountId;
    return accountOk && amountsCompatible(manualCents, cents, input.category, r.is_pending);
  });
  if (matches.length !== 1) return plain();
  const match = matches[0];

  if (match.review_status !== "needs_review") return plain(match.id);

  if (input.kind === "transfer") {
    // A transfer waiting on "Which account?" (a Venmo leg, or a card payment
    // whose paying account the email didn't name): the manual entry names it.
    const updated = (await sql`
      UPDATE transactions
         SET transfer_from = COALESCE(transfer_from, ${input.transferFrom}),
             transfer_to = COALESCE(transfer_to, ${input.transferTo}),
             review_status = 'confirmed',
             reviewed_by = ${actorId}::uuid,
             reviewed_at = now(),
             updated_at = now()
       WHERE user_id = ${userId} AND id = ${match.id} AND review_status = 'needs_review'
      RETURNING id
    `) as Array<{ id: string }>;
    if (updated.length === 0) return plain();
    return {
      row: await selectTransactionRow(sql, userId, match.id, "transfer"),
      absorbed: { transactionId: match.id, previousDescription: match.description, merchantName: null },
      possibleDuplicateOf: null,
    };
  }

  // Conditional on still being needs_review, so a spouse answering at the same
  // moment wins cleanly and this falls back to a plain insert.
  const category = input.category ?? "";
  const description = input.description.trim();
  const [updated] = await sql.transaction([
    sql`
      UPDATE transactions
         SET category = ${category},
             kind = ${input.kind},
             categorized_by = 'user',
             review_status = 'confirmed',
             reviewed_by = ${actorId}::uuid,
             reviewed_at = now(),
             entered_by = COALESCE(entered_by, ${actorId}::uuid),
             description = CASE WHEN ${description} <> '' THEN ${description} ELSE description END,
             updated_at = now()
       WHERE user_id = ${userId} AND id = ${match.id} AND review_status = 'needs_review'
      RETURNING id
    `,
    // An answer becomes the merchant's default when it has none (plan §5.5) —
    // except a Venmo person, who is never guessed (lib/email/rules.ts).
    sql`
      UPDATE merchants
         SET default_category = COALESCE(default_category, ${category})
       WHERE user_id = ${userId} AND id = ${match.merchant_id}::uuid
         AND ${input.kind === "expense" && !match.from_venmo}::boolean
    `,
  ]);
  if (!Array.isArray(updated) || updated.length === 0) return plain();

  return {
    row: await selectTransactionRow(sql, userId, match.id, input.kind),
    absorbed: {
      transactionId: match.id,
      previousDescription: match.description,
      merchantName: match.merchant_name,
    },
    possibleDuplicateOf: null,
  };
}
