-- =====================================================================
-- Migration 005 — email sync, Phase 2: account alert routing
-- =====================================================================
-- Run once against a database created from an earlier version of
-- docs/neon-setup.sql. Safe to re-run. Plan of record: docs/email-sync-plan.md.
--
-- An alert says WHICH BANK sent it (the parser) and, usually, the card's last
-- four digits. Those two together pick exactly one live account. Venmo has no
-- last four, so it is told apart by whose personal inbox forwarded it.
--
-- There is deliberately NO fallback to "the only account for this bank": a new
-- or replacement card would silently post to the wrong account. An alert that
-- doesn't resolve lands in Settings → Email sync → Unknown account instead.
-- =====================================================================

ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS alert_source         TEXT,   -- parser id: 'venmo', 'chase', …
  ADD COLUMN IF NOT EXISTS alert_last4          TEXT,
  ADD COLUMN IF NOT EXISTS alert_forwarded_from TEXT;   -- lowercased; sources with no last 4

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'financial_accounts_alert_last4_check'
  ) THEN
    ALTER TABLE financial_accounts
      ADD CONSTRAINT financial_accounts_alert_last4_check CHECK (alert_last4 ~ '^[0-9]{4}$');
  END IF;
END $$;

-- Live rows only, so a soft-deleted card doesn't reserve its digits (same
-- reasoning as idx_financial_accounts_name).
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_accounts_alert_last4
  ON financial_accounts (user_id, alert_source, alert_last4)
  WHERE deleted_at IS NULL AND alert_last4 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_accounts_alert_fwd
  ON financial_accounts (user_id, alert_source, alert_forwarded_from)
  WHERE deleted_at IS NULL AND alert_forwarded_from IS NOT NULL;
