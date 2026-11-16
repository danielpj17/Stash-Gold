-- =====================================================================
-- Migration 007 — email sync, Phase 5: push, preferences, unattended
-- =====================================================================
-- Run once against a database created from an earlier version of
-- docs/neon-setup.sql. Safe to re-run. Plan of record: docs/email-sync-plan.md.
--
-- `user_id` in push_subscriptions and notification_prefs is the ACTOR, not
-- the household scope — exactly like user_tokens. A phone belongs to a person:
-- scoping these on the household would let each spouse revoke the other's
-- devices. The fan-out query joins through `users` to reach the scope, so
-- someone who leaves the household stops getting pushes with no other change.
-- =====================================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
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

-- Also ACTOR-scoped. One row per person per account; each edits only their own.
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  enabled    BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_id)
);

ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS unattended_action TEXT NOT NULL DEFAULT 'keep_in_review';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'financial_accounts_unattended_action_check'
  ) THEN
    ALTER TABLE financial_accounts ADD CONSTRAINT financial_accounts_unattended_action_check
      CHECK (unattended_action IN ('keep_in_review', 'auto_guess'));
  END IF;
END $$;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS notified_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unattended_due_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unattended_settled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_transactions_unattended_due
  ON transactions (user_id, unattended_due_at)
  WHERE review_status = 'needs_review' AND unattended_settled_at IS NULL;
