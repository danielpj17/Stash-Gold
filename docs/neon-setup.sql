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
  -- occurred_at. See the GET /api/transactions query. In a shared household
  -- this resolves to the OWNER's timezone, so both people get one consistent
  -- month boundary rather than two.
  timezone        TEXT NOT NULL DEFAULT 'America/Denver',
  -- Household sharing. NULL = you own your own data (the common case). Set =
  -- your data scope is that user's scope, so every `user_id` filter in the app
  -- resolves to them and you see the same budget, accounts and reconciliation
  -- state. Resolved in requireUser() and NOWHERE else.
  --
  -- Exactly one level deep: the accept route refuses to point at a user who is
  -- themselves a member, so no query ever has to walk a chain.
  --
  -- Not ON DELETE CASCADE on purpose — see migration 002.
  data_owner_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_data_owner ON users(data_owner_id) WHERE data_owner_id IS NOT NULL;

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
  -- What the token may do. identityFromBearer puts this in its WHERE, so a
  -- leaked email key can't log transactions through /api/ingest and a
  -- Shortcut token can't post email. (Migration 004.)
  purpose      TEXT NOT NULL DEFAULT 'shortcut' CHECK (purpose IN ('shortcut', 'email')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX idx_user_tokens_user ON user_tokens(user_id);

-- NOTE: `user_id` here is the ACTOR, not the household scope — tokens belong to
-- a person, not to a household. /api/tokens is the one route that scopes on the
-- acting user rather than the data owner, and requireUser's bearer path relies
-- on this to work out who sent an ingest request. If tokens were
-- household-scoped, two spouses could revoke each other's Shortcut and every
-- ingested transaction would be attributed to the owner.


-- ---------------------------------------------------------------------
-- Household sharing — pending invitations.
--
-- Scoped by `owner_user_id` rather than `user_id`: this table describes a
-- relationship between two users, not data living inside one user's scope, so
-- the house rule above does not apply to it.
--
-- Only the SHA-256 hash of the token is stored (same reasoning as user_tokens).
-- The token alone is NOT sufficient to join: acceptance also requires being
-- signed in as the invited address, so a forwarded email can't be redeemed by
-- whoever received it.
-- ---------------------------------------------------------------------

CREATE TABLE household_invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,            -- stored lowercased
  token_hash    TEXT NOT NULL UNIQUE,     -- sha256 hex of the raw token
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_at   TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX idx_household_invites_owner ON household_invites(owner_user_id);
-- One LIVE invite per address per owner. Partial, so revoking or accepting an
-- invite doesn't permanently reserve that address.
CREATE UNIQUE INDEX idx_household_invites_pending
  ON household_invites (owner_user_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;


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

-- `is_default` is the account an expense lands in when none is given — the
-- iOS Shortcut can't reasonably send a UUID, so without it Shortcut-logged
-- expenses would move no balance.
--
-- `deleted_at` makes deletion a SOFT delete. Reconciliation rows reference an
-- account by id, so removing the row would leave that history unable to
-- resolve a name. Keeping it means past matches survive a deletion intact.
CREATE TABLE financial_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'checking'
                    CHECK (kind IN ('checking','savings','credit_card','cash','brokerage','other')),
  opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  -- Email sync routing (migration 005). The alert's parser id plus the card's
  -- last four pick exactly one live account; Venmo, which has no last four, is
  -- told apart by whose inbox forwarded it. No fallback to "the only account
  -- for this bank" — a replacement card would silently post to the wrong one.
  alert_source         TEXT,
  alert_last4          TEXT CHECK (alert_last4 ~ '^[0-9]{4}$'),
  alert_forwarded_from TEXT,
  -- This account also receives the parser's alerts that name no account at
  -- all, e.g. Wells Fargo Bill Pay (008). An explicit choice, one per parser.
  alert_unnumbered     BOOLEAN NOT NULL DEFAULT false,
  -- What happens to an unanswered email purchase after the timeout (007).
  unattended_action    TEXT NOT NULL DEFAULT 'keep_in_review'
                         CHECK (unattended_action IN ('keep_in_review', 'auto_guess'))
);
CREATE INDEX idx_financial_accounts_user ON financial_accounts(user_id, sort_order);
-- Names are unique among LIVE accounts only. A plain UNIQUE (user_id, name)
-- would mean deleting "Checking" permanently reserved that name, since the
-- soft-deleted row keeps it.
CREATE UNIQUE INDEX idx_financial_accounts_name
  ON financial_accounts (user_id, name)
  WHERE deleted_at IS NULL;
-- At most one default per user.
CREATE UNIQUE INDEX idx_financial_accounts_one_default
  ON financial_accounts (user_id)
  WHERE is_default AND deleted_at IS NULL;
-- Alert routing is unique among LIVE accounts only, so a soft-deleted card
-- doesn't reserve its digits (same reasoning as idx_financial_accounts_name).
CREATE UNIQUE INDEX idx_financial_accounts_alert_last4
  ON financial_accounts (user_id, alert_source, alert_last4)
  WHERE deleted_at IS NULL AND alert_last4 IS NOT NULL;
CREATE UNIQUE INDEX idx_financial_accounts_alert_fwd
  ON financial_accounts (user_id, alert_source, alert_forwarded_from)
  WHERE deleted_at IS NULL AND alert_forwarded_from IS NOT NULL;
CREATE UNIQUE INDEX idx_financial_accounts_alert_unnumbered
  ON financial_accounts (user_id, alert_source)
  WHERE deleted_at IS NULL AND alert_unnumbered;


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

-- `entered_by` is WHO logged the row; `user_id` is WHOSE data it is. In a solo
-- account they are the same person. In a shared household they differ, and the
-- reconcile page renders the name next to the date.
--
-- Display only. It must NEVER appear in a WHERE clause over transactions —
-- filtering on it would hide one spouse's entries from the other, which is the
-- exact opposite of what sharing is for.
CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entered_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('expense','income','transfer')),
  occurred_at   TIMESTAMPTZ NOT NULL,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  category      TEXT,
  description   TEXT NOT NULL DEFAULT '',
  account       TEXT,
  transfer_from TEXT,
  transfer_to   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ---- Email sync (migration 006). Every default reproduces a pre-sync row.
  source          TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual', 'shortcut', 'email', 'csv')),
  review_status   TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (review_status IN ('needs_review', 'confirmed')),
  -- Where the CURRENT category came from. 'guess' + needs_review = provisional
  -- (it counts in its bar, marked unconfirmed); 'guess' + confirmed = auto-filed
  -- by the unattended rule. NULL = a person typed it.
  categorized_by  TEXT CHECK (categorized_by IN ('user', 'rule', 'guess')),
  reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,  -- actor; display only
  reviewed_at     TIMESTAMPTZ,
  is_pending      BOOLEAN NOT NULL DEFAULT false,
  original_amount NUMERIC(14,2),
  merchant_id     UUID,          -- no FK; merchant merges repoint it in one transaction
  email_event_id  UUID,
  auto_merged     BOOLEAN NOT NULL DEFAULT false,
  duplicate_of    TEXT,          -- "Possible duplicate" flag; display only
  -- ---- Push (migration 007)
  notified_at           TIMESTAMPTZ,
  unattended_due_at     TIMESTAMPTZ,
  unattended_settled_at TIMESTAMPTZ,
  -- A CONFIRMED expense/income always has a category. A needs_review row holds
  -- its guess in `category`, or NULL when Stash has no guess at all.
  CONSTRAINT transactions_confirmed_has_category CHECK (
    kind = 'transfer' OR review_status = 'needs_review' OR category IS NOT NULL
  )
);
-- created_at is the append-order proxy the reads sort on (Sheets returned
-- rows in append order and some client code assumes newest-last).
CREATE INDEX idx_transactions_user_kind ON transactions(user_id, kind, created_at);
CREATE INDEX idx_transactions_user_time ON transactions(user_id, occurred_at);
-- The idempotency key for re-processing an email: one event creates or links ONE row.
CREATE UNIQUE INDEX idx_transactions_email_event
  ON transactions (user_id, email_event_id) WHERE email_event_id IS NOT NULL;
CREATE INDEX idx_transactions_needs_review
  ON transactions (user_id, created_at) WHERE review_status = 'needs_review';
CREATE INDEX idx_transactions_pending
  ON transactions (user_id, account, occurred_at) WHERE is_pending;
CREATE INDEX idx_transactions_merchant
  ON transactions (user_id, merchant_id) WHERE merchant_id IS NOT NULL;
CREATE INDEX idx_transactions_unattended_due
  ON transactions (user_id, unattended_due_at)
  WHERE review_status = 'needs_review' AND unattended_settled_at IS NULL;

-- A row's amount history: pending → posted, tips, gas holds, CSV corrections.
-- Deliberately not reconciliation_activity_log, which records reconciliation
-- actions and whose undo only understands claims.
CREATE TABLE transaction_amount_changes (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id             UUID NOT NULL DEFAULT gen_random_uuid(),
  transaction_id TEXT NOT NULL,
  old_amount     NUMERIC(14,2) NOT NULL,
  new_amount     NUMERIC(14,2) NOT NULL,
  reason         TEXT NOT NULL CHECK (reason IN ('posted', 'tip', 'gas_final', 'csv', 'manual', 'split_back')),
  email_event_id UUID,
  changed_by     UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL = automatic
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_amount_changes_tx
  ON transaction_amount_changes (user_id, transaction_id, changed_at);
-- A retried follow-up can't apply twice.
CREATE UNIQUE INDEX idx_amount_changes_event
  ON transaction_amount_changes (user_id, transaction_id, email_event_id)
  WHERE email_event_id IS NOT NULL;


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

-- The inverse of a claim link: pairs the user explicitly disconnected.
--
-- Without this, disconnecting is futile. handleDisconnectSheetLink deletes the
-- claim and then re-runs matching, and findMatches' first branch pairs on amount
-- and date alone — so it re-picks the same wrong row and the rematch auto-claims
-- it again. Recording the rejection is what makes the disconnect stick.
--
-- Keyed on the PAIR, never on either side alone: rejecting A->X must still let
-- A match Y and X match B. That is the whole point when several same-amount
-- subscriptions land on one date.
--
-- Claiming a pair clears its rejection (see the claims and transfer-claims POST
-- routes), so disconnect stays usable as "redo this link" rather than a one-way
-- door.
CREATE TABLE reconciliation_rejected_matches (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_hash    TEXT NOT NULL,
  sheet_name   TEXT NOT NULL DEFAULT 'Expenses',
  sheet_row_id TEXT NOT NULL,
  account_name TEXT,
  created_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, bank_hash, sheet_name, sheet_row_id)
);
CREATE INDEX idx_rejected_matches_hash ON reconciliation_rejected_matches(user_id, bank_hash);

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
-- Email transaction sync — see docs/email-sync-plan.md.
--
-- Bank/card/Venmo alert emails land in a dedicated Gmail inbox; an Apps
-- Script posts each one to /api/ingest/email with a purpose='email' token.
-- ---------------------------------------------------------------------

-- One row per data SCOPE (the owner's id). A missing row = all defaults.
CREATE TABLE email_sync_settings (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode                    TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'live')),
  answer_timeout_hours    INTEGER NOT NULL DEFAULT 24 CHECK (answer_timeout_hours BETWEEN 1 AND 168),
  internal_counterparties TEXT[] NOT NULL DEFAULT '{}',   -- Venmo names that mean "us"; lowercased
  last_heartbeat_at       TIMESTAMPTZ,
  last_heartbeat_error    TEXT,
  last_poll_at            TIMESTAMPTZ,
  last_ingest_at          TIMESTAMPTZ,
  poller_version          TEXT,
  last_poller_failure_at  TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every forwarded email, stored BEFORE processing. `received` is the only
-- non-terminal status: a retry of a `received` event re-processes it, so a
-- request that dies half-way can't lose a purchase.
--
-- Raw bodies never leave the server: no route selects raw_text / raw_html.
CREATE TABLE email_events (
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 UUID NOT NULL DEFAULT gen_random_uuid(),
  gmail_message_id   TEXT NOT NULL,
  rfc822_message_id  TEXT,
  from_address       TEXT NOT NULL,
  to_address         TEXT,
  forwarded_for      TEXT,
  subject            TEXT,
  received_at        TIMESTAMPTZ NOT NULL,
  auth_results       TEXT,
  arc_auth_results   TEXT,
  raw_text           TEXT,
  raw_html           TEXT,
  body_sha256        TEXT NOT NULL,
  truncated          BOOLEAN NOT NULL DEFAULT false,
  -- Mode when the email ARRIVED; a later re-read never upgrades it to live.
  mode_at_receipt    TEXT NOT NULL DEFAULT 'shadow' CHECK (mode_at_receipt IN ('shadow', 'live')),
  status             TEXT NOT NULL DEFAULT 'received' CHECK (status IN (
                       'received', 'created', 'linked', 'followup', 'duplicate',
                       'ignored', 'unparsed', 'unknown_account', 'unauthenticated',
                       'followup_ignored_reconciled', 'ambiguous', 'shadow')),
  status_reason      TEXT,
  parser_id          TEXT,
  parser_version     INTEGER,
  parsed             JSONB,
  decision           JSONB,
  error              TEXT,
  transaction_id     TEXT,          -- no FK, same reasoning as claim links
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, gmail_message_id)
);
CREATE INDEX idx_email_events_status ON email_events (user_id, status, received_at DESC);
CREATE INDEX idx_email_events_created ON email_events (user_id, created_at DESC);
ALTER TABLE email_events ALTER COLUMN raw_html SET COMPRESSION lz4;
ALTER TABLE email_events ALTER COLUMN raw_text SET COMPRESSION lz4;

-- Per-merchant filing rules for email transactions. Separate from
-- reconciliation_merchant_memory on purpose: that table feeds findMatches'
-- auto-claim, so email rules written there would change which bank lines
-- auto-claim. One merchant, one rule (folded in).
CREATE TABLE merchants (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  display_name     TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'ask_all'
                     CHECK (mode IN ('auto', 'ask_shortlist', 'ask_all')),
  category         TEXT,
  shortlist        TEXT[] NOT NULL DEFAULT '{}',
  default_category TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  CHECK (mode <> 'auto' OR category IS NOT NULL),
  CHECK (mode <> 'ask_shortlist' OR cardinality(shortlist) >= 1)
);

-- Exact normalized keys from lib/email/merchantKey.ts. That function is
-- near-frozen: changing it re-asks every known merchant unless the change
-- bumps MERCHANT_KEY_VERSION and ships a re-key script in the same commit.
CREATE TABLE merchant_aliases (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_key TEXT NOT NULL,
  key_version    INTEGER NOT NULL,
  merchant_id    UUID NOT NULL,
  example_raw    TEXT NOT NULL,
  last_seen_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, normalized_key),
  FOREIGN KEY (user_id, merchant_id) REFERENCES merchants (user_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_merchant_aliases_merchant ON merchant_aliases (user_id, merchant_id);

-- Web push. `user_id` in these two tables is the ACTOR, not the household
-- scope — exactly like user_tokens. A phone belongs to a person: scoping on
-- the household would let each spouse revoke the other's devices. The fan-out
-- query joins through users to reach the scope, so someone who leaves the
-- household stops getting pushes automatically.
CREATE TABLE push_subscriptions (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id              UUID NOT NULL DEFAULT gen_random_uuid(),
  endpoint        TEXT NOT NULL,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  device_label    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, endpoint)
);

CREATE TABLE notification_prefs (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  enabled    BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_id)
);


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
