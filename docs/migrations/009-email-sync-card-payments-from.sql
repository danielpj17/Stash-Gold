-- =====================================================================
-- Migration 009 — email sync: where a card's payments come from
-- =====================================================================
-- Run once against a database created from an earlier version of
-- docs/neon-setup.sql. Safe to re-run. Plan of record: docs/email-sync-plan.md.
--
-- A card's "We've received your payment" email names the card but never the
-- account that paid it, so the transfer waits on "Which account?" until the
-- bank's side turns up. Most people pay a card from one account every time.
-- Saying so on the card ("Payments come from: Checking") makes the card's
-- email alone a complete transfer — a stated rule per card, like Bill Pay's
-- alert_unnumbered (008), never a guess.
--
-- No foreign key, like every other account reference: the API checks the
-- account is a live one in the same scope, and decide() ignores the setting
-- if that account is later deleted.
-- =====================================================================

ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS payments_from_account_id UUID;
