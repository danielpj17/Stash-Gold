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
  t.account                                                        AS "account"
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
  to_char(t.occurred_at AT TIME ZONE u.timezone, 'FMMM')           AS "month"
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

export async function insertTransaction(
  sql: Sql,
  userId: string,
  input: TransactionInput,
): Promise<TransactionRow> {
  const id = randomUUID();

  // An expense with no account contributes to budgets and totals but moves no
  // balance, which is a silent surprise. The iOS Shortcut can't reasonably send
  // a UUID, so fall back to the user's default account.
  const account =
    input.kind === "transfer" ? null : input.account ?? (await getDefaultAccountId(sql, userId));

  await sql`
    INSERT INTO transactions (
      id, user_id, kind, occurred_at, amount,
      category, description, account, transfer_from, transfer_to
    )
    VALUES (
      ${id}, ${userId}::uuid, ${input.kind}, ${input.occurredAt}::timestamptz, ${input.amount},
      ${input.category}, ${input.description}, ${account},
      ${input.transferFrom}, ${input.transferTo}
    )
  `;

  const fields = input.kind === "transfer" ? TRANSFER_SELECT_FIELDS : EXPENSE_SELECT_FIELDS;
  const rows = (await sql(
    `SELECT ${fields}
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     WHERE t.user_id = $1 AND t.id = $2`,
    [userId, id],
  )) as TransactionRow[];

  return stripDateIfDisabled(rows[0] ?? { rowId: id });
}
