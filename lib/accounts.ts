import type { Sql } from "@/lib/db";
import type { BankProfile } from "@/services/reconciliationService";

export const ACCOUNT_KINDS = [
  "checking",
  "savings",
  "credit_card",
  "cash",
  "brokerage",
  "other",
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export type FinancialAccount = {
  id: string;
  name: string;
  kind: AccountKind;
  openingBalance: number;
  isActive: boolean;
  sortOrder: number;
  /** Present once the user has confirmed a CSV mapping for this account. */
  csvProfile: StoredCsvProfile | null;
};

export type StoredCsvProfile = {
  hasHeader: boolean;
  headerRowIndex: number;
  dateIndex: number | null;
  amountIndex: number | null;
  descriptionIndex: number | null;
  debitIndex: number | null;
  creditIndex: number | null;
  outflowIsPositive: boolean;
  deriveDateFromDescription: boolean;
  detectedAutomatically: boolean;
  sampleHeaders: string[];
};

export function normalizeAccountKind(value: unknown): AccountKind {
  const raw = String(value ?? "").trim();
  return (ACCOUNT_KINDS as readonly string[]).includes(raw) ? (raw as AccountKind) : "other";
}

/** Shape the parser wants. Returns null when the account has no confirmed mapping. */
export function toBankProfile(profile: StoredCsvProfile | null | undefined): BankProfile | null {
  if (!profile) return null;
  return {
    dateIndex: profile.dateIndex,
    amountIndex: profile.amountIndex,
    descriptionIndex: profile.descriptionIndex,
    debitIndex: profile.debitIndex,
    creditIndex: profile.creditIndex,
    deriveDateFromDescription: profile.deriveDateFromDescription,
  };
}

type AccountRow = {
  id: string;
  name: string;
  kind: string;
  opening_balance: string | number;
  is_active: boolean;
  sort_order: number;
  has_header: boolean | null;
  header_row_index: number | null;
  date_index: number | null;
  amount_index: number | null;
  description_index: number | null;
  debit_index: number | null;
  credit_index: number | null;
  outflow_is_positive: boolean | null;
  derive_date_from_description: boolean | null;
  detected_automatically: boolean | null;
  sample_headers: unknown;
};

function mapRow(row: AccountRow): FinancialAccount {
  // date_index is NOT NULL-able in the profile table only when a profile row
  // exists; LEFT JOIN gives all-null when it doesn't.
  const hasProfile = row.has_header !== null;
  return {
    id: String(row.id),
    name: String(row.name),
    kind: normalizeAccountKind(row.kind),
    openingBalance: Number(row.opening_balance ?? 0),
    isActive: row.is_active !== false,
    sortOrder: Number(row.sort_order ?? 0),
    csvProfile: hasProfile
      ? {
          hasHeader: row.has_header === true,
          headerRowIndex: Number(row.header_row_index ?? 0),
          dateIndex: row.date_index,
          amountIndex: row.amount_index,
          descriptionIndex: row.description_index,
          debitIndex: row.debit_index,
          creditIndex: row.credit_index,
          outflowIsPositive: row.outflow_is_positive === true,
          deriveDateFromDescription: row.derive_date_from_description === true,
          detectedAutomatically: row.detected_automatically === true,
          sampleHeaders: Array.isArray(row.sample_headers)
            ? row.sample_headers.map((h) => String(h ?? ""))
            : [],
        }
      : null,
  };
}

const SELECT_ACCOUNTS = (sql: Sql, userId: string) => sql`
  SELECT
    a.id, a.name, a.kind, a.opening_balance, a.is_active, a.sort_order,
    p.has_header, p.header_row_index, p.date_index, p.amount_index,
    p.description_index, p.debit_index, p.credit_index,
    p.outflow_is_positive, p.derive_date_from_description,
    p.detected_automatically, p.sample_headers
  FROM financial_accounts a
  LEFT JOIN account_csv_profiles p ON p.account_id = a.id
  WHERE a.user_id = ${userId}
  ORDER BY a.sort_order ASC, a.name ASC
`;

export async function listAccounts(sql: Sql, userId: string): Promise<FinancialAccount[]> {
  const rows = (await SELECT_ACCOUNTS(sql, userId)) as AccountRow[];
  return rows.map(mapRow);
}

export async function getAccount(
  sql: Sql,
  userId: string,
  accountId: string,
): Promise<FinancialAccount | null> {
  const accounts = await listAccounts(sql, userId);
  return accounts.find((a) => a.id === accountId) ?? null;
}

/**
 * Load the parsing profile for one account. Routes that parse CSV call this
 * instead of consulting a hardcoded bank table.
 */
export async function getBankProfile(
  sql: Sql,
  userId: string,
  accountId: string,
): Promise<BankProfile | null> {
  const account = await getAccount(sql, userId, accountId);
  return toBankProfile(account?.csvProfile);
}
