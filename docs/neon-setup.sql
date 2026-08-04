-- =====================================================================
-- Stash — multi-user Neon Postgres schema
-- =====================================================================
-- Run this ONCE, in full, on a fresh Neon database.
--
-- This is the single source of truth for the schema. API routes no longer
-- create tables at request time (the old `ensureXTable` helpers are gone),
-- so anything missing here will simply fail at runtime rather than being
-- silently auto-created in a drifted shape.
--
-- Replaces: neon-schema-complete.sql, neon-budget-setup.sql,
--           neon-manual-assets-liabilities.sql, neon-budget-setup.md
--
-- House rule: EVERY table that holds user data carries `user_id` and has it
-- prepended to the primary key and to every UNIQUE constraint.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(); no-op on PG13+


-- ---------------------------------------------------------------------
-- Auth.js (@auth/neon-adapter)
--
-- Table and column names (including the quoted camelCase ones) are fixed by
-- the adapter — do not rename them. The adapter never supplies an `id` on
-- INSERT, so UUID primary keys work in place of the documented SERIAL.
--
-- `users` may carry extra columns: the adapter's getSessionAndUser does
-- SELECT *, so anything added here is available in the session callback for
-- free, with no extra query.
-- ---------------------------------------------------------------------

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255),
  email           VARCHAR(255) UNIQUE,
  "emailVerified" TIMESTAMPTZ,
  image           TEXT,
  -- Used to derive the local calendar date/month for a transaction's
  -- occurred_at. See the GET /api/transactions query.
  timezone        TEXT NOT NULL DEFAULT 'America/Denver',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OAuth / provider links. NOTE: this is an Auth.js table. A user's *bank*
-- accounts live in `financial_accounts` below.
CREATE TABLE accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                VARCHAR(255) NOT NULL,
  provider            VARCHAR(255) NOT NULL,
  "providerAccountId" VARCHAR(255) NOT NULL,
  refresh_token       TEXT,
  access_token        TEXT,
  expires_at          BIGINT,
  id_token            TEXT,
  scope               TEXT,
  session_state       TEXT,
  token_type          TEXT,
  UNIQUE (provider, "providerAccountId")
);
CREATE INDEX idx_accounts_user ON accounts("userId");

CREATE TABLE sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires        TIMESTAMPTZ NOT NULL,
  "sessionToken" VARCHAR(255) NOT NULL UNIQUE
);
CREATE INDEX idx_sessions_user ON sessions("userId");

CREATE TABLE verification_token (
  identifier TEXT NOT NULL,
  expires    TIMESTAMPTZ NOT NULL,
  token      TEXT NOT NULL,
  PRIMARY KEY (identifier, token)
);


-- ---------------------------------------------------------------------
-- API tokens for the iOS Shortcut (POST /api/ingest)
--
-- Only the SHA-256 hash of the token is stored; the raw value is shown once
-- at creation and never again. 256 bits of CSPRNG entropy has nothing to
-- brute-force, so a plain hash is correct here (same reasoning as GitHub PATs).
-- ---------------------------------------------------------------------

CREATE TABLE user_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT 'iOS Shortcut',
  token_hash   TEXT NOT NULL UNIQUE,   -- sha256 hex of the raw token
  prefix       TEXT NOT NULL,          -- first 13 chars, for display only
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX idx_user_tokens_user ON user_tokens(user_id);


-- ---------------------------------------------------------------------
-- Financial accounts — user-defined, replacing the old hardcoded account
-- lists (BASE_ACCOUNT_BALANCES, ACCOUNT_OPTIONS, PROFILE_BY_ACCOUNT, ...).
--
-- `id` is the IMMUTABLE internal key. It is what gets written into every
-- `account_name` column in the reconciliation tables below, and into
-- `bankTransaction.accountName` inside reconciliation_match_cache.match_data.
-- `name` is display-only, so renaming an account never orphans reconciliation
-- state.
--
-- `kind` drives sign conventions and net-worth treatment. A credit_card
-- defaults to outflow_is_positive = true in its CSV profile.
-- ---------------------------------------------------------------------

CREATE TABLE financial_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'checking'
                    CHECK (kind IN ('checking','savings','credit_card','cash','brokerage','other')),
  opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX idx_financial_accounts_user ON financial_accounts(user_id, sort_order);


-- ---------------------------------------------------------------------
-- CSV parsing profile, one per account.
--
-- Replaces the hardcoded BANK_PROFILES / PROFILE_BY_ACCOUNT maps. The parser
-- itself is unchanged — only the source of the column indexes moves from a
-- constant to this table.
--
--   outflow_is_positive          -> the `outgoingIsPositive` option already
--                                   accepted by findMatches. Credit cards and
--                                   debit/credit-column CSVs set this true.
--   derive_date_from_description -> extract "PURCHASE AUTHORIZED ON MM/DD"
--                                   from the description instead of using the
--                                   posted date (Wells-Fargo-style CSVs).
-- ---------------------------------------------------------------------

CREATE TABLE account_csv_profiles (
  account_id                   UUID PRIMARY KEY REFERENCES financial_accounts(id) ON DELETE CASCADE,
  user_id                      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  has_header                   BOOLEAN NOT NULL DEFAULT true,
  header_row_index             INTEGER NOT NULL DEFAULT 0,
  date_index                   INTEGER,
  amount_index                 INTEGER,
  description_index            INTEGER,
  debit_index                  INTEGER,
  credit_index                 INTEGER,
  outflow_is_positive          BOOLEAN NOT NULL DEFAULT false,
  derive_date_from_description BOOLEAN NOT NULL DEFAULT false,
  detected_automatically       BOOLEAN NOT NULL DEFAULT false,
  sample_headers               JSONB,
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_account_csv_profiles_user ON account_csv_profiles(user_id);


-- ---------------------------------------------------------------------
-- Transactions — replaces the Google Sheets "Expenses" and "Transfers" tabs.
--
-- `id` is TEXT holding an opaque UUID, matching the shape the reconciliation
-- tables already expect in sheet_row_id / transfer_sheet_row_id. There is
-- deliberately NO foreign key from those tables to this one: the app already
-- tolerates dangling links (the match route renders "linked sheet row was not
-- found"), and an FK would break claim_delete undo.
--
-- `category` keeps the sheet's "Expense Type" string VERBATIM, including the
-- literal 'Income'. Several call sites branch on that exact value
-- (accountBalancesService, the budget page), so `kind` is a convenience
-- discriminator and `category` is the round-trip-fidelity field.
--
-- `account`, `transfer_from` and `transfer_to` hold a financial_accounts.id
-- as text, OR a free-text external label ("Parents", "Cash", "Misc.") for
-- money entering or leaving the tracked set. Balance math ignores labels it
-- cannot resolve to an account, which is exactly the pre-existing behavior.
-- ---------------------------------------------------------------------

CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('expense','income','transfer')),
  occurred_at   TIMESTAMPTZ NOT NULL,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  category      TEXT,
  description   TEXT NOT NULL DEFAULT '',
  account       TEXT,
  transfer_from TEXT,
  transfer_to   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- created_at is the append-order proxy the reads sort on (Sheets returned
-- rows in append order and some client code assumes newest-last).
CREATE INDEX idx_transactions_user_kind ON transactions(user_id, kind, created_at);
CREATE INDEX idx_transactions_user_time ON transactions(user_id, occurred_at);


-- ---------------------------------------------------------------------
-- Budget — one JSONB blob per user. The old `id = 1` singleton is gone.
-- ---------------------------------------------------------------------

CREATE TABLE budget_store (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data    JSONB NOT NULL DEFAULT '{}'
);


-- ---------------------------------------------------------------------
-- Reconciliation — core state
--
-- `account_name` throughout these tables holds a financial_accounts.id.
-- The column keeps its historical name because it is also embedded in
-- reconciliation_activity_log.payload and in match_data JSONB.
--
-- `sheet_name` keeps its legacy 'Expenses' | 'Transfers' literals: they are
-- compared as strings in the match and claims routes and are baked into every
-- activity-log payload. Renaming them would require a JSONB rewrite.
-- ---------------------------------------------------------------------

-- Hashes of bank rows that have already been handled.
CREATE TABLE processed_transactions (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash         TEXT NOT NULL,
  account_name TEXT,
  processed_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, hash)
);

-- Confirmed statement balances, used to rebase account balance math.
CREATE TABLE account_anchors (
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_name      TEXT NOT NULL,
  confirmed_balance NUMERIC,
  as_of_date        DATE,
  PRIMARY KEY (user_id, account_name)
);

-- Links a bank row to the transaction it claims.
-- UNIQUE (user_id, sheet_name, sheet_row_id) => one logged entry, one bank row.
CREATE TABLE reconciliation_claim_links (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_hash    TEXT NOT NULL,
  account_name TEXT,
  sheet_name   TEXT NOT NULL DEFAULT 'Expenses',
  sheet_row_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, bank_hash, sheet_name, sheet_row_id),
  UNIQUE (user_id, sheet_name, sheet_row_id)
);
CREATE INDEX idx_claim_links_hash ON reconciliation_claim_links(user_id, bank_hash);

-- Links a bank row to one leg of a transfer (which may have 1 or 2 legs).
-- UNIQUE (user_id, bank_hash) => one bank row claims at most one leg.
CREATE TABLE reconciliation_transfer_claim_links (
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transfer_sheet_row_id TEXT NOT NULL,
  bank_hash             TEXT NOT NULL,
  bank_account_name     TEXT,
  bank_amount_cents     INTEGER NOT NULL,
  expected_legs         INTEGER NOT NULL DEFAULT 2 CHECK (expected_legs IN (1, 2)),
  created_at            TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, transfer_sheet_row_id, bank_hash),
  UNIQUE (user_id, bank_hash)
);

-- Bank statement rows the user dismissed (fees, refunds — nothing to log).
CREATE TABLE reconciliation_statement_dismissals (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash         TEXT NOT NULL,
  account_name TEXT NOT NULL,
  note         TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, hash, account_name)
);

-- Logged entries the user dismissed (will never appear on a statement).
CREATE TABLE reconciliation_user_sheet_dismissals (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_name   TEXT NOT NULL,
  sheet_row_id TEXT NOT NULL,
  note         TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, sheet_name, sheet_row_id)
);


-- ---------------------------------------------------------------------
-- Reconciliation — caches & uploads
--
-- `seq` is load-bearing, not decoration. disambiguateHashes() appends
-- -2/-3 suffixes to duplicate bank hashes based on ARRAY ORDER, and that
-- array comes from reading this table ordered by created_at. created_at
-- defaults to now(), which is TRANSACTION time, so every row inserted in the
-- same chunk shares a timestamp and their relative order is undefined.
-- Tie-breaking on seq makes those suffixes stable across reads forever.
-- Both read sites (csv-rows and dedupe routes) order by (created_at, seq).
-- ---------------------------------------------------------------------

CREATE TABLE reconciliation_csv_rows (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_name TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  cells        JSONB NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  seq          BIGSERIAL,
  PRIMARY KEY (user_id, account_name, dedupe_key)
);
CREATE INDEX idx_csv_rows_order
  ON reconciliation_csv_rows(user_id, account_name, created_at, seq);

CREATE TABLE reconciliation_match_cache (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_name TEXT NOT NULL,
  bank_hash    TEXT NOT NULL,
  match_data   JSONB NOT NULL,
  updated_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, account_name, bank_hash)
);

CREATE TABLE reconciliation_uploaded_files (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_name TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  bank_hashes  JSONB,   -- every tx hash from that file, so it can be cleared
  PRIMARY KEY (user_id, account_name, file_name)
);


-- ---------------------------------------------------------------------
-- Reconciliation — learning & audit
-- ---------------------------------------------------------------------

-- Recurring merchants auto-claim after 2 confirmations.
CREATE TABLE reconciliation_merchant_memory (
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint       TEXT NOT NULL,
  bank_account_name TEXT NOT NULL,
  sheet_category    TEXT,
  sheet_account     TEXT,
  confirmed_count   INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, fingerprint, bank_account_name)
);

-- Audit trail of every reconciliation action; powers per-action undo.
-- `actor` stays 'user' | 'auto_match' | 'memory_match' — it records WHAT
-- caused an action, not WHO. Identity is user_id. Do not conflate them:
-- the Activity tab renders on actor.
CREATE TABLE reconciliation_activity_log (
  id                    UUID PRIMARY KEY,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurred_at           TIMESTAMP NOT NULL DEFAULT now(),
  action_type           TEXT NOT NULL,
  actor                 TEXT NOT NULL,
  csv_upload_id         UUID,
  bulk_action_id        UUID,
  parent_action_id      UUID,
  payload               JSONB NOT NULL,
  reverted_at           TIMESTAMP,
  reverted_by_action_id UUID
);
CREATE INDEX idx_activity_log_occurred
  ON reconciliation_activity_log(user_id, occurred_at DESC);
CREATE INDEX idx_activity_log_csv
  ON reconciliation_activity_log(user_id, csv_upload_id);


-- ---------------------------------------------------------------------
-- Net worth — manual assets / liabilities. `id` is client-generated text,
-- so it must be scoped by user or one user could address another's row.
-- ---------------------------------------------------------------------

CREATE TABLE manual_assets (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id               TEXT NOT NULL,
  name             TEXT NOT NULL,
  value            NUMERIC(14,2) NOT NULL,
  category         TEXT NOT NULL,
  acquisition_date DATE,
  details          JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE manual_liabilities (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id               TEXT NOT NULL,
  name             TEXT NOT NULL,
  value            NUMERIC(14,2) NOT NULL,
  category         TEXT NOT NULL,
  acquisition_date DATE,
  details          JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
