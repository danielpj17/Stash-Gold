import { randomUUID } from "crypto";
import { getDefaultAccountId } from "@/lib/accounts";
import type { Sql } from "@/lib/db";

export type TransactionKind = "expense" | "income" | "transfer";

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

/** Columns aliased to the exact camelCase field names the client expects. */
export const EXPENSE_SELECT_FIELDS = `
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
      category, description, account, transfer_from, transfer_to
    )
    VALUES (
      ${id}, ${userId}::uuid, ${actorId}::uuid,
      ${input.kind}, ${input.occurredAt}::timestamptz, ${input.amount},
      ${input.category}, ${input.description}, ${account},
      ${input.transferFrom}, ${input.transferTo}
    )
  `;

  const fields = input.kind === "transfer" ? TRANSFER_SELECT_FIELDS : EXPENSE_SELECT_FIELDS;
  const rows = (await sql(
    `SELECT ${fields}
     FROM transactions t
     ${TRANSACTION_JOINS}
     WHERE t.user_id = $1 AND t.id = $2`,
    [userId, id],
  )) as TransactionRow[];

  return stripDateIfDisabled(rows[0] ?? { rowId: id });
}
