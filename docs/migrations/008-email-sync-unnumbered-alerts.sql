-- =====================================================================
-- Migration 008 — email sync: alerts that name no account (Bill Pay)
-- =====================================================================
-- Run once against a database created from an earlier version of
-- docs/neon-setup.sql. Safe to re-run. Plan of record: docs/email-sync-plan.md.
--
-- Some bank emails never say which account the money left. Wells Fargo's
-- "Bill Pay: Your payment(s) were sent" lists the payee, amount and date, and
-- only "your selected account(s)". Account routing never guesses (§5.4), so
-- such an alert needs an explicit answer: the person ticks "Bill Pay comes
-- out of this account" on ONE account. That is a stated rule, not a fallback
-- to "the only account for this bank".
--
-- One per parser per scope, live rows only (same reasoning as the other
-- alert-routing indexes): a soft-deleted account doesn't keep the role.
-- =====================================================================

ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS alert_unnumbered BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_accounts_alert_unnumbered
  ON financial_accounts (user_id, alert_source)
  WHERE deleted_at IS NULL AND alert_unnumbered;
