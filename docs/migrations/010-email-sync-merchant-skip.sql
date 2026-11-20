-- =====================================================================
-- Migration 010 — email sync: "Don't record — I log these myself"
-- =====================================================================
-- Run once against a database created from an earlier version of
-- docs/neon-setup.sql. Safe to re-run. Plan of record: docs/email-sync-plan.md.
--
-- A merchant rule can now say "skip": alerts for it record nothing. For a
-- payment a person deliberately logs by hand in pieces — a donation split
-- across several entries — no single row matches the bank's total, so the
-- "already recorded" check can't see it and the line would be doubled.
-- =====================================================================

ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_mode_check;
ALTER TABLE merchants
  ADD CONSTRAINT merchants_mode_check CHECK (mode IN ('auto', 'ask_shortlist', 'ask_all', 'skip'));
