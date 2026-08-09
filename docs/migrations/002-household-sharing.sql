-- =====================================================================
-- Migration 002 — household sharing (two people, one Stash)
-- =====================================================================
-- Run once against a database created from an earlier version of
-- docs/neon-setup.sql. Safe to re-run. Fresh databases get all of this from
-- neon-setup.sql directly.
--
-- Lets a second person sign in with their own email and see the same data.
-- The design deliberately does NOT introduce a household id: `user_id` keeps
-- its meaning as "the data scope", and that scope is simply the owner's user
-- id. Membership is one nullable pointer on `users`, resolved in
-- requireUser() and nowhere else. Every existing query is untouched.
--
-- Three changes:
--
-- 1. `users.data_owner_id` — NULL means you own your own data (the only state
--    that exists today). Set means your data scope is that user's scope.
--    Exactly one level deep: acceptance refuses to point at a user who is
--    themselves a member, so there are no chains to walk.
--
-- 2. `transactions.entered_by` — WHO logged the row, as opposed to `user_id`
--    which is WHOSE data it is. Display only; it must never appear in a WHERE
--    clause over user data, or one spouse's rows would vanish from the other's
--    view.
--
-- 3. `household_invites` — pending invitations. Note this table is scoped by
--    `owner_user_id`, not `user_id`: it is about the relationship between two
--    users rather than being data inside one user's scope, so the house rule
--    about a `user_id` column does not apply. scripts/check-schema.mjs knows.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Membership
-- ---------------------------------------------------------------------

-- NOT ON DELETE CASCADE, and that is deliberate. Deleting an owner already
-- cascades away all the shared data through every user_id foreign key; making
-- this cascade too would silently delete the *member's login* as well. ON
-- DELETE SET NULL leaves them a working account pointing at nothing, which is
-- recoverable. Better still: never delete an owner with members attached.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS data_owner_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Partial: the overwhelming majority of rows are NULL (solo users), so there
-- is no reason to index them.
CREATE INDEX IF NOT EXISTS idx_users_data_owner
  ON users (data_owner_id)
  WHERE data_owner_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Attribution
-- ---------------------------------------------------------------------

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS entered_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Backfill: before sharing existed, every row in a scope was entered by the
-- person who owns that scope. This is accurate rather than approximate, and it
-- means a household never shows a mix of attributed and unattributed history.
UPDATE transactions
   SET entered_by = user_id
 WHERE entered_by IS NULL;

-- ---------------------------------------------------------------------
-- 3. Invites
-- ---------------------------------------------------------------------

-- Only the SHA-256 hash of the invite token is stored, matching user_tokens:
-- the raw value goes out in the email and is never persisted. The token alone
-- is NOT sufficient to join — acceptance also requires being signed in as the
-- invited address, so a forwarded email cannot be redeemed by someone else.
CREATE TABLE IF NOT EXISTS household_invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,            -- stored lowercased
  token_hash    TEXT NOT NULL UNIQUE,     -- sha256 hex of the raw token
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_at   TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_household_invites_owner
  ON household_invites (owner_user_id);

-- One live invite per address per owner. Partial so that a revoked or accepted
-- invite doesn't permanently block re-inviting the same person — the same
-- reasoning as idx_financial_accounts_name.
CREATE UNIQUE INDEX IF NOT EXISTS idx_household_invites_pending
  ON household_invites (owner_user_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
