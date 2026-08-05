-- =====================================================================
-- Migration 001 — default account + soft-deleted accounts
-- =====================================================================
-- Run once against a database that was created from an earlier version of
-- docs/neon-setup.sql. Safe to re-run (every statement is IF NOT EXISTS or
-- idempotent). Fresh databases get all of this from neon-setup.sql directly.
--
-- Two changes:
--
-- 1. `is_default` — the account that expenses land in when none is specified.
--    The iOS Shortcut can't reasonably send a UUID, so without this every
--    Shortcut-logged expense had no account and moved no balance.
--
-- 2. `deleted_at` — deleting an account is now a SOFT delete. Reconciliation
--    rows (claims, processed hashes, dismissals, match cache) reference an
--    account by id, so hard-deleting the row would leave that history pointing
--    at an account whose name can no longer be resolved — matched transactions
--    would still be matched, but would render as raw UUIDs. Keeping the row
--    means past matches survive a deletion completely intact.
-- =====================================================================

ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- At most one default per user. A partial unique index rather than a
-- constraint so that unsetting a default is just is_default = false.
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_accounts_one_default
  ON financial_accounts (user_id)
  WHERE is_default AND deleted_at IS NULL;

-- Account names must be unique among LIVE accounts only. The original table
-- constraint covered every row, which with soft delete would mean deleting
-- "Checking" permanently reserved that name.
ALTER TABLE financial_accounts
  DROP CONSTRAINT IF EXISTS financial_accounts_user_id_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_accounts_name
  ON financial_accounts (user_id, name)
  WHERE deleted_at IS NULL;

-- Backfill: give every user that has no default one — their oldest
-- non-deleted account, which is almost always the first one they created.
WITH first_account AS (
  SELECT DISTINCT ON (user_id) id, user_id
  FROM financial_accounts
  WHERE deleted_at IS NULL
  ORDER BY user_id, sort_order ASC, created_at ASC
)
UPDATE financial_accounts a
   SET is_default = true
  FROM first_account f
 WHERE a.id = f.id
   AND NOT EXISTS (
     SELECT 1 FROM financial_accounts d
      WHERE d.user_id = a.user_id AND d.is_default AND d.deleted_at IS NULL
   );
