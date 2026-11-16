-- =====================================================================
-- Migration 004 — email sync, Phase 1: token purpose, settings, raw events
-- =====================================================================
-- Run once against a database created from an earlier version of
-- docs/neon-setup.sql. Safe to re-run. Fresh databases get this from
-- neon-setup.sql directly. Plan of record: docs/email-sync-plan.md §4.
--
-- Three changes, all additive. Nothing existing is rewritten.
--
-- 1. `user_tokens.purpose` — a token is either the iOS Shortcut's or the
--    Gmail poller's. `identityFromBearer` puts the purpose in its WHERE, so a
--    leaked email key can't log arbitrary transactions through /api/ingest and
--    a Shortcut token can't post email. Every existing token is a Shortcut
--    token, which is what the DEFAULT backfills.
--
-- 2. `email_sync_settings` — one row per data SCOPE (the owner's user id),
--    like every scope table. There is no household table: the scope is the
--    household. A missing row means "all defaults" (shadow mode).
--
-- 3. `email_events` — every email the poller forwards, stored BEFORE it is
--    processed. `received` is the only non-terminal status: a retry of an
--    event still in `received` re-processes it (plan C14), which is what stops
--    a request that dies mid-way from losing a purchase forever.
-- =====================================================================

ALTER TABLE user_tokens
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'shortcut';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_tokens_purpose_check'
  ) THEN
    ALTER TABLE user_tokens
      ADD CONSTRAINT user_tokens_purpose_check CHECK (purpose IN ('shortcut', 'email'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS email_sync_settings (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode                    TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'live')),
  answer_timeout_hours    INTEGER NOT NULL DEFAULT 24 CHECK (answer_timeout_hours BETWEEN 1 AND 168),
  -- D6: Venmo display names that mean "us" (the other spouse). Lowercased.
  internal_counterparties TEXT[] NOT NULL DEFAULT '{}',
  last_heartbeat_at       TIMESTAMPTZ,
  last_heartbeat_error    TEXT,
  last_poll_at            TIMESTAMPTZ,
  last_ingest_at          TIMESTAMPTZ,
  poller_version          TEXT,
  -- Set when an Apps Script failure notice arrives in the Stash inbox.
  last_poller_failure_at  TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_events (
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 UUID NOT NULL DEFAULT gen_random_uuid(),
  gmail_message_id   TEXT NOT NULL,
  rfc822_message_id  TEXT,
  from_address       TEXT NOT NULL,
  to_address         TEXT,
  forwarded_for      TEXT,          -- X-Forwarded-For: whose personal inbox forwarded it
  subject            TEXT,
  received_at        TIMESTAMPTZ NOT NULL,
  auth_results       TEXT,          -- Authentication-Results header, verbatim
  arc_auth_results   TEXT,          -- ARC-Authentication-Results, for Gmail-forwarded mail
  raw_text           TEXT,
  raw_html           TEXT,
  body_sha256        TEXT NOT NULL, -- duplicate-delivery detection
  truncated          BOOLEAN NOT NULL DEFAULT false,
  -- The scope's mode when this email ARRIVED. Re-reading an event later never
  -- upgrades it to live: purchases that arrived during shadow were logged by
  -- hand, so writing them now would double them.
  mode_at_receipt    TEXT NOT NULL DEFAULT 'shadow' CHECK (mode_at_receipt IN ('shadow', 'live')),
  status             TEXT NOT NULL DEFAULT 'received' CHECK (status IN (
                       'received',          -- NOT terminal: a retry re-processes it
                       'created', 'linked', 'followup', 'duplicate',
                       'ignored',           -- declined, transfers, marketing, Gmail notices
                       'unparsed', 'unknown_account', 'unauthenticated',
                       'followup_ignored_reconciled',
                       'ambiguous',         -- a follow-up matched >1 purchase; a person picks
                       'shadow')),          -- parsed in shadow mode; nothing written
  status_reason      TEXT,
  parser_id          TEXT,
  parser_version     INTEGER,
  parsed             JSONB,         -- ParsedAlert exactly as produced
  decision           JSONB,         -- decide()'s plan, including in shadow mode
  error              TEXT,
  transaction_id     TEXT,          -- no FK, same reasoning as claim links
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, gmail_message_id)
);
CREATE INDEX IF NOT EXISTS idx_email_events_status
  ON email_events (user_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_events_created
  ON email_events (user_id, created_at DESC);

-- lz4 where the server supports it (PG14+ built with lz4, which Neon is).
-- Default pglz TOAST still compresses otherwise, so a failure here is harmless.
DO $$
BEGIN
  ALTER TABLE email_events ALTER COLUMN raw_html SET COMPRESSION lz4;
  ALTER TABLE email_events ALTER COLUMN raw_text SET COMPRESSION lz4;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'lz4 column compression unavailable; using the default TOAST compression';
END $$;
