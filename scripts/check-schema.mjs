#!/usr/bin/env node
/**
 * Read-only schema check.
 *
 * API routes no longer create their own tables (the old `ensureXTable` helpers
 * are gone, because CREATE TABLE IF NOT EXISTS cannot add user_id or change a
 * primary key, and two of them had already drifted from the real schema).
 * This script is the replacement safety net: run it after applying
 * docs/neon-setup.sql and after each deploy.
 *
 *   node scripts/check-schema.mjs
 *
 * Exits non-zero if anything expected is missing.
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env.local", ".env"]) {
    try {
      // [ \t]* rather than \s*: \s matches newlines, so on an empty
      // `DATABASE_URL=` line it would skip ahead and capture the next
      // non-blank line (a comment) as the connection string.
      const match = readFileSync(file, "utf8").match(/^DATABASE_URL[ \t]*=[ \t]*(.*)$/m);
      if (!match) continue;
      const value = match[1].trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    } catch {
      /* file absent — try the next one */
    }
  }
  return null;
}

/** Tables that hold per-user data: each must have user_id in its primary key. */
const USER_SCOPED = [
  "user_tokens",
  "financial_accounts",
  "account_csv_profiles",
  "transactions",
  "budget_store",
  "processed_transactions",
  "account_anchors",
  "reconciliation_claim_links",
  "reconciliation_transfer_claim_links",
  "reconciliation_rejected_matches",
  "reconciliation_statement_dismissals",
  "reconciliation_user_sheet_dismissals",
  "reconciliation_csv_rows",
  "reconciliation_match_cache",
  "reconciliation_uploaded_files",
  "reconciliation_merchant_memory",
  "reconciliation_activity_log",
  "manual_assets",
  "manual_liabilities",
  // Email sync (docs/email-sync-plan.md). Scope-keyed like everything above.
  "email_sync_settings",
  "email_events",
  "merchants",
  "merchant_aliases",
  "transaction_amount_changes",
];

/**
 * Tables whose `user_id` is the ACTOR (the person), not the household scope —
 * the user_tokens precedent. A device and a notification preference belong to
 * one person; scoping them on the household would let each spouse revoke the
 * other's phone. They still carry user_id first in every PK/UNIQUE, so the
 * same structural checks apply; only the meaning of the column differs.
 */
const ACTOR_SCOPED = ["push_subscriptions", "notification_prefs"];

/** Auth.js adapter tables — owned by the library, not user-scoped themselves. */
const AUTH_TABLES = ["users", "accounts", "sessions", "verification_token"];

/**
 * Tables that hold data but are NOT user-scoped in the house-rule sense.
 * `household_invites` describes a relationship between two users, so it is
 * keyed by owner_user_id and deliberately has no user_id column.
 */
const OTHER_TABLES = ["household_invites"];

/**
 * Unique/primary constraints the routes name explicitly in ON CONFLICT.
 * A mismatch here surfaces at runtime as a 502, so check it up front.
 */
const EXPECTED_CONSTRAINTS = [
  ["budget_store", ["user_id"]],
  ["processed_transactions", ["user_id", "hash"]],
  ["account_anchors", ["user_id", "account_name"]],
  ["reconciliation_claim_links", ["user_id", "sheet_name", "sheet_row_id"]],
  ["reconciliation_transfer_claim_links", ["user_id", "bank_hash"]],
  ["reconciliation_rejected_matches", ["user_id", "bank_hash", "sheet_name", "sheet_row_id"]],
  ["reconciliation_statement_dismissals", ["user_id", "hash", "account_name"]],
  ["reconciliation_user_sheet_dismissals", ["user_id", "sheet_name", "sheet_row_id"]],
  ["reconciliation_csv_rows", ["user_id", "account_name", "dedupe_key"]],
  ["reconciliation_match_cache", ["user_id", "account_name", "bank_hash"]],
  ["reconciliation_uploaded_files", ["user_id", "account_name", "file_name"]],
  ["reconciliation_merchant_memory", ["user_id", "fingerprint", "bank_account_name"]],
  ["manual_assets", ["user_id", "id"]],
  ["manual_liabilities", ["user_id", "id"]],
  ["email_sync_settings", ["user_id"]],
  ["email_events", ["user_id", "gmail_message_id"]],
  ["merchants", ["user_id", "id"]],
  ["merchant_aliases", ["user_id", "normalized_key"]],
  ["push_subscriptions", ["user_id", "endpoint"]],
  ["notification_prefs", ["user_id", "account_id"]],
  // financial_accounts' name uniqueness is a PARTIAL index (live rows only),
  // which doesn't appear in information_schema — checked separately below.
];

/** Partial unique indexes, which information_schema.table_constraints omits. */
const EXPECTED_INDEXES = [
  ["reconciliation_rejected_matches", "idx_rejected_matches_hash"],
  ["financial_accounts", "idx_financial_accounts_name"],
  ["financial_accounts", "idx_financial_accounts_one_default"],
  ["household_invites", "idx_household_invites_pending"],
  ["financial_accounts", "idx_financial_accounts_alert_last4", "005-email-sync-account-routing.sql"],
  ["financial_accounts", "idx_financial_accounts_alert_fwd", "005-email-sync-account-routing.sql"],
  ["financial_accounts", "idx_financial_accounts_alert_unnumbered", "008-email-sync-unnumbered-alerts.sql"],
  // The idempotency key that stops a re-processed email from inserting twice.
  ["transactions", "idx_transactions_email_event", "006-email-sync-merchants-review.sql"],
  ["transaction_amount_changes", "idx_amount_changes_event", "006-email-sync-merchants-review.sql"],
];

/**
 * Columns added after the initial schema, and the migration that adds them.
 * A database created from an older neon-setup.sql needs these applied.
 */
const EXPECTED_COLUMNS = [
  ["financial_accounts", "is_default", "001-default-account-and-soft-delete.sql"],
  ["financial_accounts", "deleted_at", "001-default-account-and-soft-delete.sql"],
  ["users", "data_owner_id", "002-household-sharing.sql"],
  ["transactions", "entered_by", "002-household-sharing.sql"],
  ["user_tokens", "purpose", "004-email-sync-ingest.sql"],
  ["financial_accounts", "alert_source", "005-email-sync-account-routing.sql"],
  ["financial_accounts", "alert_last4", "005-email-sync-account-routing.sql"],
  ["financial_accounts", "alert_forwarded_from", "005-email-sync-account-routing.sql"],
  ["transactions", "source", "006-email-sync-merchants-review.sql"],
  ["transactions", "review_status", "006-email-sync-merchants-review.sql"],
  ["transactions", "categorized_by", "006-email-sync-merchants-review.sql"],
  ["transactions", "merchant_id", "006-email-sync-merchants-review.sql"],
  ["transactions", "email_event_id", "006-email-sync-merchants-review.sql"],
  ["transactions", "duplicate_of", "006-email-sync-merchants-review.sql"],
  ["financial_accounts", "unattended_action", "007-push-notifications.sql"],
  ["transactions", "unattended_due_at", "007-push-notifications.sql"],
  ["financial_accounts", "alert_unnumbered", "008-email-sync-unnumbered-alerts.sql"],
  ["financial_accounts", "payments_from_account_id", "009-email-sync-card-payments-from.sql"],
];

async function main() {
  const url = loadDatabaseUrl();
  if (!url) {
    console.error("DATABASE_URL is not set (checked env, .env.local, .env).");
    console.error("Add your Neon connection string to .env.local and save the file.");
    process.exit(1);
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error(`DATABASE_URL doesn't look like a Postgres URL: ${url.slice(0, 40)}…`);
    console.error("Expected it to start with postgresql://");
    process.exit(1);
  }
  const sql = neon(url);
  const problems = [];

  const tableRows = await sql`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `;
  const tables = new Set(tableRows.map((r) => r.table_name));

  // Tables added after the initial schema name their migration, matching what
  // EXPECTED_COLUMNS does — a bare "missing table" leaves the fix to guesswork.
  const TABLE_MIGRATIONS = {
    reconciliation_rejected_matches: "003-rejected-matches.sql",
    email_sync_settings: "004-email-sync-ingest.sql",
    email_events: "004-email-sync-ingest.sql",
    merchants: "006-email-sync-merchants-review.sql",
    merchant_aliases: "006-email-sync-merchants-review.sql",
    transaction_amount_changes: "006-email-sync-merchants-review.sql",
    push_subscriptions: "007-push-notifications.sql",
    notification_prefs: "007-push-notifications.sql",
  };
  for (const t of [...AUTH_TABLES, ...USER_SCOPED, ...ACTOR_SCOPED, ...OTHER_TABLES]) {
    if (tables.has(t)) continue;
    const migration = TABLE_MIGRATIONS[t];
    problems.push(
      migration ? `missing table: ${t} — run docs/migrations/${migration}` : `missing table: ${t}`,
    );
  }

  const columnRows = await sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'user_id'
  `;
  const withUserId = new Set(columnRows.map((r) => r.table_name));
  for (const t of [...USER_SCOPED, ...ACTOR_SCOPED]) {
    if (tables.has(t) && !withUserId.has(t)) {
      problems.push(`table ${t} has no user_id column`);
    }
  }

  // seq backs the deterministic ordering that keeps disambiguateHashes stable.
  const seqRows = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'reconciliation_csv_rows'
      AND column_name = 'seq'
  `;
  if (tables.has("reconciliation_csv_rows") && seqRows.length === 0) {
    problems.push("reconciliation_csv_rows is missing the seq column");
  }

  const constraintRows = await sql`
    SELECT tc.table_name, tc.constraint_name, kcu.column_name, kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
  `;
  const byConstraint = new Map();
  for (const row of constraintRows) {
    const key = `${row.table_name}::${row.constraint_name}`;
    if (!byConstraint.has(key)) byConstraint.set(key, { table: row.table_name, cols: [] });
    byConstraint.get(key).cols.push([Number(row.ordinal_position), row.column_name]);
  }
  const constraintSets = [...byConstraint.values()].map((c) => ({
    table: c.table,
    cols: c.cols.sort((a, b) => a[0] - b[0]).map(([, name]) => name),
  }));

  for (const [table, expected] of EXPECTED_CONSTRAINTS) {
    if (!tables.has(table)) continue;
    const found = constraintSets.some(
      (c) =>
        c.table === table &&
        c.cols.length === expected.length &&
        expected.every((col, i) => c.cols[i] === col),
    );
    if (!found) {
      problems.push(`${table}: no PK/UNIQUE on (${expected.join(", ")}) — ON CONFLICT will fail`);
    }
  }

  // Columns added after the initial schema — a database created from an older
  // neon-setup.sql needs docs/migrations applied. The message names the exact
  // migration so the fix doesn't require reading this script.
  const allColumns = await sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
  `;
  const haveColumn = new Set(allColumns.map((r) => `${r.table_name}::${r.column_name}`));
  for (const [table, column, migration] of EXPECTED_COLUMNS) {
    if (tables.has(table) && !haveColumn.has(`${table}::${column}`)) {
      problems.push(`${table} is missing "${column}" — run docs/migrations/${migration}`);
    }
  }

  const indexRows = await sql`
    SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public'
  `;
  const haveIndexes = new Set(indexRows.map((r) => `${r.tablename}::${r.indexname}`));
  for (const [table, index, migration] of EXPECTED_INDEXES) {
    if (tables.has(table) && !haveIndexes.has(`${table}::${index}`)) {
      problems.push(
        `${table}: missing index ${index} — run docs/migrations/${migration ?? ""}`,
      );
    }
  }

  // A CHECK whose allowed values grew: "skip" merchant rules (010). Without it
  // saving "Don't record — I log these myself" fails with a check violation.
  if (tables.has("merchants")) {
    const modeCheck = await sql`
      SELECT pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'merchants' AND c.conname = 'merchants_mode_check'
    `;
    if (!modeCheck[0] || !String(modeCheck[0].def).includes("'skip'")) {
      problems.push(`merchants: mode check doesn't allow 'skip' — run docs/migrations/010-email-sync-merchant-skip.sql`);
    }
  }

  if (problems.length > 0) {
    console.error("Schema check FAILED:\n");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nApply docs/neon-setup.sql to a fresh database.");
    process.exit(1);
  }

  const verified =
    USER_SCOPED.length + ACTOR_SCOPED.length + AUTH_TABLES.length + OTHER_TABLES.length;
  console.log(`Schema check passed — ${verified} tables verified.`);
}

main().catch((err) => {
  console.error("Schema check errored:", err.message);
  process.exit(1);
});
