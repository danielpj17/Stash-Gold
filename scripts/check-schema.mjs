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
  "reconciliation_statement_dismissals",
  "reconciliation_user_sheet_dismissals",
  "reconciliation_csv_rows",
  "reconciliation_match_cache",
  "reconciliation_uploaded_files",
  "reconciliation_merchant_memory",
  "reconciliation_activity_log",
  "manual_assets",
  "manual_liabilities",
];

/** Auth.js adapter tables — owned by the library, not user-scoped themselves. */
const AUTH_TABLES = ["users", "accounts", "sessions", "verification_token"];

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
  ["reconciliation_statement_dismissals", ["user_id", "hash", "account_name"]],
  ["reconciliation_user_sheet_dismissals", ["user_id", "sheet_name", "sheet_row_id"]],
  ["reconciliation_csv_rows", ["user_id", "account_name", "dedupe_key"]],
  ["reconciliation_match_cache", ["user_id", "account_name", "bank_hash"]],
  ["reconciliation_uploaded_files", ["user_id", "account_name", "file_name"]],
  ["reconciliation_merchant_memory", ["user_id", "fingerprint", "bank_account_name"]],
  ["manual_assets", ["user_id", "id"]],
  ["manual_liabilities", ["user_id", "id"]],
  ["financial_accounts", ["user_id", "name"]],
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

  for (const t of [...AUTH_TABLES, ...USER_SCOPED]) {
    if (!tables.has(t)) problems.push(`missing table: ${t}`);
  }

  const columnRows = await sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'user_id'
  `;
  const withUserId = new Set(columnRows.map((r) => r.table_name));
  for (const t of USER_SCOPED) {
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

  if (problems.length > 0) {
    console.error("Schema check FAILED:\n");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nApply docs/neon-setup.sql to a fresh database.");
    process.exit(1);
  }

  console.log(`Schema check passed — ${USER_SCOPED.length + AUTH_TABLES.length} tables verified.`);
}

main().catch((err) => {
  console.error("Schema check errored:", err.message);
  process.exit(1);
});
