-- =====================================================================
-- Migration 006 — email sync, Phase 3: merchants, review state, amount history
-- =====================================================================
-- Run once against a database created from an earlier version of
-- docs/neon-setup.sql. Safe to re-run. Plan of record: docs/email-sync-plan.md.
--
-- Wrapped in one transaction, and it checks its own precondition first: the
-- new CHECK constraint assumes no existing expense lacks a category. If any
-- do, the whole migration stops before changing anything and says what to run.
--
-- Changes:
--
-- 1. `merchants` + `merchant_aliases` — per-merchant filing rules for email
--    transactions. Separate from reconciliation_merchant_memory ON PURPOSE:
--    that table is keyed by generateMerchantFingerprint (which includes a
--    dollar bucket) and feeds findMatches' auto-claim step, so writing email
--    rules into it would change which bank lines auto-claim. (Plan C26.)
--    The rule is folded into the merchant row: one merchant, one rule (C7).
--    Aliases store EXACT normalized keys from lib/email/merchantKey.ts (C8).
--
-- 2. Additive `transactions` columns. Every default reproduces today's rows
--    exactly: source 'manual', review_status 'confirmed', not pending.
--
-- 3. `transaction_amount_changes` — a row's amount history (pending → posted,
--    tips, gas holds, CSV corrections). Not the activity log, which records
--    reconciliation actions and whose undo only knows claims (C27).
-- =====================================================================

BEGIN;

DO $$
DECLARE
  missing INTEGER;
BEGIN
  SELECT count(*) INTO missing
    FROM transactions
   WHERE kind <> 'transfer' AND (category IS NULL OR btrim(category) = '');
  IF missing > 0 THEN
    RAISE EXCEPTION
      'Migration 006 stopped: % expense/income row(s) have no category. Backfill them first: UPDATE transactions SET category = ''Misc.'' WHERE kind <> ''transfer'' AND (category IS NULL OR btrim(category) = '''');',
      missing;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS merchants (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  display_name     TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'ask_all'
                     CHECK (mode IN ('auto', 'ask_shortlist', 'ask_all')),
  category         TEXT,                        -- mode = auto
  shortlist        TEXT[] NOT NULL DEFAULT '{}', -- mode = ask_shortlist ("Other" is always offered)
  default_category TEXT,                        -- pre-selected; also the provisional guess (D2)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  CHECK (mode <> 'auto' OR category IS NOT NULL),
  CHECK (mode <> 'ask_shortlist' OR cardinality(shortlist) >= 1)
);

CREATE TABLE IF NOT EXISTS merchant_aliases (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_key TEXT NOT NULL,               -- merchantKey(raw)
  key_version    INTEGER NOT NULL,            -- MERCHANT_KEY_VERSION that produced it
  merchant_id    UUID NOT NULL,
  example_raw    TEXT NOT NULL,               -- one raw string as seen, for the Rules page and re-keying
  last_seen_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, normalized_key),
  FOREIGN KEY (user_id, merchant_id) REFERENCES merchants (user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_merchant_aliases_merchant
  ON merchant_aliases (user_id, merchant_id);

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS source          TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS review_status   TEXT NOT NULL DEFAULT 'confirmed',
  -- Where the CURRENT category came from. 'guess' + needs_review = provisional
  -- (D2); 'guess' + confirmed = auto-filed by the unattended rule. Either way
  -- the UI marks it "unconfirmed" until a person picks. NULL = a person typed
  -- it (every row from before this migration, and every manual entry).
  ADD COLUMN IF NOT EXISTS categorized_by  TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,  -- actor; display only
  ADD COLUMN IF NOT EXISTS reviewed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_pending      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS original_amount NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS merchant_id     UUID,          -- no FK; merges repoint it in the same transaction
  ADD COLUMN IF NOT EXISTS email_event_id  UUID,
  ADD COLUMN IF NOT EXISTS auto_merged     BOOLEAN NOT NULL DEFAULT false,
  -- "Possible duplicate" flag: set on a manual entry saved after an already
  -- confirmed email row of the same amount. Points at that row. Cleared by
  -- Keep both or by deleting one of them. Display only.
  ADD COLUMN IF NOT EXISTS duplicate_of    TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_source_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
      CHECK (source IN ('manual', 'shortcut', 'email', 'csv'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_review_status_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_review_status_check
      CHECK (review_status IN ('needs_review', 'confirmed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_categorized_by_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_categorized_by_check
      CHECK (categorized_by IN ('user', 'rule', 'guess'));
  END IF;
  -- A CONFIRMED expense/income always has a category. A needs_review row holds
  -- its guess in `category` (D2), or NULL when Stash has no guess at all.
  -- Transfers never carry a category (they can be needs_review: "which Venmo?").
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_confirmed_has_category') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_confirmed_has_category CHECK (
      kind = 'transfer' OR review_status = 'needs_review' OR category IS NOT NULL
    );
  END IF;
END $$;

-- The idempotency key for re-processing (C14): one event creates or links ONE row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_email_event
  ON transactions (user_id, email_event_id) WHERE email_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_needs_review
  ON transactions (user_id, created_at) WHERE review_status = 'needs_review';
CREATE INDEX IF NOT EXISTS idx_transactions_pending
  ON transactions (user_id, account, occurred_at) WHERE is_pending;
CREATE INDEX IF NOT EXISTS idx_transactions_merchant
  ON transactions (user_id, merchant_id) WHERE merchant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS transaction_amount_changes (
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
CREATE INDEX IF NOT EXISTS idx_amount_changes_tx
  ON transaction_amount_changes (user_id, transaction_id, changed_at);
-- A retried follow-up can't apply twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_amount_changes_event
  ON transaction_amount_changes (user_id, transaction_id, email_event_id)
  WHERE email_event_id IS NOT NULL;

COMMIT;
