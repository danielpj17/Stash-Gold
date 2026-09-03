-- =====================================================================
-- Migration 003 — rejected matches (make "Disconnect" stick)
-- =====================================================================
-- Run once against a database created from an earlier version of
-- docs/neon-setup.sql. Safe to re-run. Fresh databases get this from
-- neon-setup.sql directly.
--
-- The problem this fixes:
--
-- Disconnecting an auto-match deleted the claim link and the processed marker,
-- then finished by calling rematchAllStoredAccounts(). That rematch re-ran
-- findMatches, whose first branch pairs a bank line to a logged expense on
-- amount and date ALONE — the description is never consulted — and then
-- auto-claimed the result. With two subscriptions at the same amount on the
-- same date it re-picked the same wrong row every time, so the disconnect was
-- undone by its own last step.
--
-- Nothing recorded the user's decision, so there was nothing for the rematch
-- to consult. This table is that record.
--
-- Design notes:
--
-- * Keyed on the PAIR (bank_hash, sheet_name, sheet_row_id), never on either
--   side alone. Rejecting A->X must still leave A free to match Y and X free
--   to match B — which is exactly the case that goes wrong today.
-- * Both halves of the key are durable: bank_hash comes from the frozen
--   hashing functions, sheet_row_id is the transaction UUID.
-- * account_name is denormalized for display and debugging only. Never filter
--   matching on it — bank_hash already identifies the account's row.
-- * A rejection is cleared when the user claims that same pair, so Disconnect
--   remains "redo this link" rather than a one-way door.

CREATE TABLE IF NOT EXISTS reconciliation_rejected_matches (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_hash    TEXT NOT NULL,
  sheet_name   TEXT NOT NULL DEFAULT 'Expenses',
  sheet_row_id TEXT NOT NULL,
  account_name TEXT,
  created_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, bank_hash, sheet_name, sheet_row_id)
);

CREATE INDEX IF NOT EXISTS idx_rejected_matches_hash
  ON reconciliation_rejected_matches(user_id, bank_hash);
