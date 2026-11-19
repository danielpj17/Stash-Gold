# Plan: Email transaction sync

> Status: **code for Phases 1–5 built 2026-11-15; not yet deployed.**
> Migrations 004–007 are written but not applied, the bank parsers wait on
> real samples (Phase 1 collects them), and every acceptance check below is
> still to be run by hand. §11 lists where the build departed from this text.
> Source: "Stash: Email Transaction Sync Plan" (Daniel, Nov 15 2026). This
> document is the plan of record. Where it differs from the source, §1 says
> why. `/CLAUDE.md` has the short version and this file stays as the
> rationale.

## Goal

Bank, card and Venmo alert emails flow into a dedicated Gmail inbox. An Apps
Script forwards each one to Stash. Stash turns it into a logged transaction,
files it by per-merchant rules, and asks one of the two people when it can't.
There is no paid aggregator. Manual entry, the iOS Shortcut and monthly CSV
reconciliation keep working exactly as they do now, and they recognise the
transactions that came from email.

Five properties drive the design. Each one maps to a failure that would
otherwise be silent:

1. **Nothing is lost.** An email is either processed to a terminal state or
   retried. A crash mid-request can't swallow it.
2. **Nothing is doubled.** Every path that can record the same purchase twice is
   deduped before the first email transaction is written, not one phase later.
3. **Nothing is guessed silently.** Every automatic decision (a rule, a guess, a
   merge) is visible, labelled and reversible.
4. **The frozen surface stays frozen.** No hashing function, no `findMatches`
   scoring, no `user_id` semantics change.
5. **Every rollout is observable before it is trusted.** Parsers run in shadow
   mode against real mail before they write anything.

### What does not change

- The New Expense form, the iOS Shortcut and its token flow (one additive
  column on `user_tokens`), and the household model.
- `generateTransactionHash`, `cleanBankDescription`, `parseBankAmount`,
  `normalizeDateOnly`, `disambiguateHashes`, `generateMerchantFingerprint` and
  `findMatches`. Email transactions are ordinary logged entries to the matcher.
- The 16 hardcoded categories in `lib/constants.ts`.
- Budget storage.

---

## 1. Where the source plan conflicts with the code

The source plan says to follow the code's conventions and note conflicts. These
are those notes.

**Tie-break rule (Daniel, 2026-11-15): when in doubt, make the new plan conform
to what already exists.** Implementers should apply it to anything this
document doesn't settle. Reuse an existing table, route, pattern or screen
before adding one. A new piece is justified only where the existing one would
break an invariant or change existing behavior, and the rows below say which.

| # | Source plan | What the code actually does | Plan of record |
|---|---|---|---|
| C1 | `X-Stash-Secret` shared secret in an env var | A shared secret carries no identity. Invariant 2 forbids taking `user_id` from the request, so one env secret can't say *whose* data an email belongs to. `user_tokens` + `identityFromBearer` already solve this for the Shortcut. | The Apps Script sends `Authorization: Bearer stsh_…` using a Stash-minted token with a new **purpose `email`**. It is hashed at rest, revocable in Settings, and resolves to the household scope. "Constant-time compare" is moot because tokens are looked up by SHA-256, never compared. |
| C2 | `/api/jobs/unattended` + Vercel cron | Every bearer-reachable route lives under `app/api/ingest/`, so one directory answers "what can a stolen token do?". Vercel Hobby crons run once a day. A cron job would also need the app's first cross-scope query. | `POST /api/ingest/email/heartbeat`, called every 15 min by a second Apps Script trigger using the same token. It settles overdue items for **that token's scope only**. Every read of the queue also settles lazily. No Vercel cron, no cross-user query. |
| C3 | `accounts` table | `accounts` is the Auth.js OAuth table. Bank accounts are `financial_accounts`. | Extend `financial_accounts`. |
| C4 | `category_id`, `shortlist_category_ids` | Categories are 16 hardcoded strings. `transactions.category` stores the name verbatim. | Category names stored as `TEXT` / `TEXT[]` and validated against `EXPENSE_CATEGORIES` in code. (`/CLAUDE.md` says 15. There are 16; fix the doc.) |
| C5 | `owner (joint / Daniel / Katie)` on accounts | The source plan's own notification section says Stash doesn't decide by owner, so nothing would ever read it. | Dropped. Notifications are per-person opt-ins. If it's wanted as a label later: `owner_actor_id UUID NULL`. |
| C6 | `alert_sender` on accounts | The sender identifies the *bank* (the parser). The last 4 digits identify the *account*. Venmo has no last 4. | `alert_source` (parser id) + `alert_last4`, plus `alert_forwarded_from` for sources with no last 4 (Venmo: whose inbox forwarded it). |
| C7 | Separate `merchant_rules` table | Each merchant has exactly one rule, always. | Folded into `merchants`. That's one less join and makes an orphaned rule impossible. |
| C8 | `merchant_aliases.pattern` globs (`SMITHS #*`) | Normalization already strips store numbers. Globs add ambiguity (two patterns can match one string, so which wins?). | Aliases store **exact normalized keys**. All the fuzziness lives in one tested function (§5.5). |
| C9 | `transactions.status` / "Review queue" | "Needs review" already names a Reconcile section (`User-inputted: Needs review` = unreconciled entries). The same word would mean two things. | Column `review_status`. The UI calls it **To categorize** (`/categorize`). |
| C10 | `transactions.csv_matched_at` | Already derivable from `reconciliation_claim_links.created_at`. A copy goes stale when a claim is disconnected or undone. | Not added. Derived. |
| C11 | `household_settings` table | There is no household table: the scope *is* the owner's `user_id`. | `email_sync_settings`, keyed by `user_id` (the scope). |
| C12 | `email_events` unique on `gmail_message_id` | Invariant 1: `user_id` prefixes every UNIQUE. | `UNIQUE (user_id, gmail_message_id)`. |
| C13 | `push_subscriptions` / `notification_subscriptions` keyed by user | A device and a notification preference belong to a **person**. Scoping them on the household would let each spouse revoke the other's devices. This is the `user_tokens` precedent. | `user_id` in these two tables holds the **actor**, with the same warning comment `user_tokens` carries. The fan-out query joins through `users` to the scope, so someone who leaves the household stops getting pushes automatically. |
| C14 | "A repeat id returns 200 and does nothing" | If a request dies after saving the event but before writing the transaction, the retry would no-op and **that purchase is lost forever**. | A repeat is a no-op only once the event has reached a **terminal** status. An event still in `received` is re-processed. `UNIQUE (user_id, email_event_id)` on `transactions` makes re-processing unable to double-insert. |
| C15 | Label processed mail with `stash-processed` | `GmailApp` labels **threads**. Banks send identically-subjected alerts that Gmail threads together, so labelling the thread after message 1 marks messages 2…n processed. **Those transactions are silently skipped.** | Use the Advanced Gmail service to list and label individual **messages**. |
| C16 | Dedupe and amount updates in Phase 4, transaction creation in Phase 3 | The moment email creates transactions, every Shortcut-logged purchase and every pending→posted alert pair doubles. | Email-vs-manual dedupe, duplicate-alert detection and **explicit** posted/amount-changed updates ship *with* transaction creation (Phase 3). Phase 4 adds the heuristics (tips and gas holds without a posted alert) and CSV tolerance. |
| C17 | "Before creating a row from the CSV, match it… No match: create it as today" | The CSV never creates rows. `findMatches` pairs bank lines with logged entries, and Quick Add creates one only when the user asks. Email rows are logged entries, so the matcher already handles them. The real gap is amount tolerance: `findMatches` needs exact amounts, and `/claims` requires links to sum to the bank amount. | `findMatches` stays untouched. A separate client-side pass offers "Correct to $17.50 & link" on unmatched bank lines that look like a tipped or held email row. That is a PATCH (logged with reason `csv`) followed by the ordinary claim. It never auto-claims. |
| C18 | "Look for a manual transaction **on the same account**" | New Expense has **no account picker**, so its rows always land on the default account. The Shortcut offers "Default" too. Requiring the same account would miss most real duplicates. | Match on amount and a ±2-day window. The account must equal the alert's **or** the manual row must be on the default account. When that happens, the alert's account wins, which also fixes balances. |
| C19 | Tip rule: same restaurant, 0–35% higher, within 5 days | Most alerts are *authorization* alerts, so the earlier row is nearly always still pending. Two genuine dinners at the same place in one week would merge and one would vanish. | D3 (default chosen): auto-merge on explicit posted/changed alerts. The heuristic merges only with exactly one candidate, and every heuristic merge can be undone ("Split back into two"). |
| C20 | Gas-hold rule checks only that the *earlier* amount looks like a hold | A second $1.00 hold at the same station would merge into the first fill-up. | The *new* alert must not itself look like a hold. |
| C21 | Amount updates on any matching transaction | Once a row is claimed in reconciliation, `reconciliation_claim_links.amount_cents` is fixed. Changing the row's amount breaks the "links sum to the bank amount" rule. | Follow-ups never change the amount of a **claimed** row. The event is recorded as `followup_ignored_reconciled`. |
| C22 | "Settings → Notifications" | `/CLAUDE.md` says `/settings` holds "sharing and sign-out, and nothing else". | Settings gains **Email sync** and **Notifications** sections, and `/CLAUDE.md` is updated deliberately. Rules get their own page. |
| C23 | Incoming money (refunds, "payment received") | `transactions.amount > 0` and there are no negative expenses. Today refunds and paybacks are **dismissed** at reconcile. | D1: created as `Income` (the existing literal category), so the schema is unchanged. The exceptions are Venmo↔bank movements, which become transfers (D4), and card payments, which stay ignored as today. See §5.12. |
| C24 | Keep the raw email forever | Neon storage is finite, and HTML alerts run 30–150 KB each. | Keep it, with `lz4` column compression where Neon supports it (TOAST compresses by default anyway). Rough math: at ~10 alerts/day compressed to 5–15 KB each, that's well under 100 MB/year. Check the Neon plan's limit in Phase 0. |
| C25 | `entered_by` (implicit) | `entered_by` means "who logged it", and the household subtitle renders it. | `NULL` for email-created rows (nobody logged them). New `reviewed_by` records who answered, for "Already filed by Katie as Dates". Display-only, never in a `WHERE`. |
| C26 | New `merchants` tables (implicit: why not reuse merchant memory?) | `reconciliation_merchant_memory` already maps merchants to categories, but it's keyed by `generateMerchantFingerprint` (which includes a **dollar bucket**) plus a bank account, and it **feeds `findMatches`'** auto-claim step. Writing email rules into it would change which bank lines auto-claim, and one merchant at varying prices would scatter across many rows. | Separate `merchants` tables. Merchant memory is untouched, and `generateMerchantFingerprint` stays frozen. |
| C27 | `transaction_amount_changes` (implicit: why not the activity log?) | `reconciliation_activity_log` records **reconciliation** actions. The Activity tab renders every row, and `/activity/[id]/undo` only knows claim and processed actions. Finding "this row's amount history" would mean a JSONB scan of the payload. | A dedicated table, as the source plan specifies. The activity log keeps its meaning. |

---

## 2. Decisions (answered by Daniel, 2026-11-15)

| # | Question | Decision | What it changes | Phase |
|---|---|---|---|---|
| D1 | Incoming-money alerts (refunds, Venmo "X paid you", deposits) | **Create them as Income transactions.** | Money-in alerts write `kind = 'income'`, `category = 'Income'`, confirmed, with no question and no push. Two kinds of money-in are **not** income: Venmo moving money to or from a bank (D4), and payments to a credit card. See §5.12. | 3 |
| D2 | How an unanswered purchase shows in the budget | **Count it in the total *and* in its guessed category, with a clear signal that it isn't officially categorized.** This replaces the source plan's "nothing is filed silently into a guessed category": the guess counts, but never silently. | A `needs_review` row carries its guess in `category`, so the bar moves now, drawn as an "unconfirmed" share. Only rows with no guess at all fall into the "Awaiting category" line. See §5.5 and §5.10. | 3 |
| D3 | Tip merge without a posted alert | **Default:** exactly one pending candidate, new alert 12 h–5 days later, labelled "auto-merged" with **Split back into two**. | As written in §5.6. | 4 |
| D4 | Venmo payment funded by a bank or card | **A transfer from the bank/card to Venmo, plus the expense on Venmo.** | This is the transfer model the app already uses. The card's balance moves, Venmo nets to zero, and the budget sees one expense. A bank or card alert whose merchant is Venmo is **never** an expense or income. See §5.12. | 3 (guard) / 4 (transfers) |
| D5 | Where To categorize lives in the PWA | **Default:** banners on New Expense and Budget, plus push deep links. No sixth nav icon. | As written. **Later:** consider moving it into Reconcile. Build the list as a self-contained component (`CategorizeQueue`), so that move is a re-mount, not a rewrite. | 3 |
| D6 | Venmo payments between Daniel and Katie | **Default:** treated as internal, ignored. The other person's Venmo name goes in `internal_counterparties`, set in Settings → Email sync. | As written. | 2 |

---

## 3. Architecture

```
 Bank / card / Venmo
   │  alert email: direct to the Stash address, OR Gmail filter-forward
   │  from Daniel's / Katie's personal inbox
   ▼
 Stash Gmail inbox
   │  Apps Script, every 1 min. LockService (no overlapping runs),
   │  per-MESSAGE labels, oldest first, ≤25 per run, 45 s time budget
   │
   │  POST /api/ingest/email            Authorization: Bearer stsh_… (purpose=email)
   │  POST /api/ingest/email/heartbeat  every 15 min
   ▼
 Stash  (Vercel, Node runtime)
   1  identify      requireUser(req, { bearerPurpose: "email" }) → scope
   2  store raw     email_events  UNIQUE (user_id, gmail_message_id)  → status 'received'
   3  route         registry.forSender(from)  → parser | ignore-list | unparsed
   4  authenticate  DKIM pass for that parser's domains, else 'unauthenticated'
   5  parse         parser.parse() → ParsedAlert | unparsed     (throws are caught)
   6  resolve acct  (alert_source, last4) or (alert_source, forwarded_from)
   7  load context  accounts, merchant by key, candidate rows (pending / manual / recent)
   8  decide        PURE: duplicate? follow-up? link manual? new → rule → review status
   9  apply         live: one sql.transaction([...]) │ shadow: write the decision only
  10  notify        subscribed people for that account (Phase 5); never fails the request
   ▼
 /categorize  ◄── push tap deep-links to /categorize/[id]
   ▼
 Monthly CSV → existing Reconcile (findMatches untouched) + "pending amount" suggestions
```

**Pipeline = pure `decide()` + side-effecting `apply()`.** Step 8 takes the
parsed alert and a loaded context and returns a plan
(`{ action: "create" | "link_manual" | "followup" | "duplicate" | "ignore", … }`).
Keeping it pure buys three things:

- **Shadow mode** is "run `decide()`, store the plan on the event, skip `apply()`".
- **Unit tests** cover every merge and dedupe rule with no database.
- **Re-reading old emails** after a parser fix becomes a dry-run diff for free.

### How each invariant is honoured

| Invariant | How |
|---|---|
| 1. `user_id` on every table, in every PK/UNIQUE, in every query | Every new table follows it. `push_subscriptions` and `notification_prefs` carry the **actor** in `user_id` (the `user_tokens` precedent), and their fan-out query filters to the scope through a `users` join. Every `DELETE` filters on `user_id`, including merchant merges. |
| 2. `user_id` never from the request | The token resolves the scope. The Apps Script body carries no identity. `to` / `X-Forwarded-For` are used only to pick an **account inside the already-resolved scope**, never to choose a scope. |
| 3. `userId` ≠ `actorId` | Transactions, merchants, events and settings scope on `userId`. Devices and notification prefs scope on `actorId`. `reviewed_by` is display-only. |
| 4. Hashing frozen; `findMatches` stable | Email rows are logged entries, so no bank hash is involved. The new merchant normalizer is a **separate** module. `cleanBankDescription` and `generateMerchantFingerprint` (which keys merchant memory) are untouched. The CSV tolerance pass lives outside `findMatches` and never auto-claims. |
| 5. `processedHashes` from the caller | Untouched. |
| 6. Soft-delete accounts | Account resolution ignores deleted accounts. The partial unique index on alert fields covers live rows only, so a replacement card can reuse the last 4 digits. |

### The bearer surface after this

`app/api/ingest/` grows from two routes to four. `/api/ingest` and
`/api/ingest/accounts` accept only `shortcut` tokens, and the two email routes
accept only `email` tokens. A wrong-purpose token simply doesn't resolve: the
purpose is in the `WHERE` of `identityFromBearer`, so it doesn't even bump
`last_used_at`. `middleware.ts` already exempts the `/api/ingest` prefix, so no
middleware change is needed.

---

## 4. Schema

One migration per phase, so each phase ships, and can be verified, on its own.
Each also goes into `docs/neon-setup.sql`, and `scripts/check-schema.mjs` learns
the new tables, constraints and partial indexes (it already inspects
`pg_indexes` for partial ones).

### 004 (Phase 1): token purpose, settings, raw events

```sql
ALTER TABLE user_tokens
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'shortcut'
    CHECK (purpose IN ('shortcut', 'email'));

-- One row per data scope. Keyed by the OWNER's id, like every scope table.
CREATE TABLE email_sync_settings (
  user_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode                  TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'live')),
  answer_timeout_hours  INTEGER NOT NULL DEFAULT 24 CHECK (answer_timeout_hours BETWEEN 1 AND 168),
  internal_counterparties TEXT[] NOT NULL DEFAULT '{}',   -- D6: Venmo names that mean "us"
  last_heartbeat_at     TIMESTAMPTZ,
  last_heartbeat_error  TEXT,
  last_ingest_at        TIMESTAMPTZ,
  poller_version        TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_events (
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
  raw_text           TEXT,
  raw_html           TEXT,
  body_sha256        TEXT NOT NULL, -- duplicate-delivery detection
  status             TEXT NOT NULL DEFAULT 'received' CHECK (status IN (
                       'received',          -- not yet terminal: a retry RE-PROCESSES it
                       'created', 'linked', 'followup', 'duplicate',
                       'ignored',           -- declined, D1 money-in, transfer, marketing, Gmail notices
                       'unparsed', 'unknown_account', 'unauthenticated',
                       'followup_ignored_reconciled',
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
CREATE INDEX idx_email_events_status ON email_events (user_id, status, received_at DESC);
-- Where supported (PG14+ built with lz4). Default pglz TOAST still compresses otherwise.
ALTER TABLE email_events ALTER COLUMN raw_html SET COMPRESSION lz4;
ALTER TABLE email_events ALTER COLUMN raw_text SET COMPRESSION lz4;
```

### 005 (Phase 2): account alert routing

```sql
ALTER TABLE financial_accounts
  ADD COLUMN alert_source         TEXT,   -- parser id: 'chase', 'venmo', …
  ADD COLUMN alert_last4          TEXT CHECK (alert_last4 ~ '^[0-9]{4}$'),
  ADD COLUMN alert_forwarded_from TEXT;   -- lowercased; for sources with no last 4
-- Live rows only, so a soft-deleted card doesn't reserve its digits (same
-- reasoning as idx_financial_accounts_name).
CREATE UNIQUE INDEX idx_financial_accounts_alert_last4
  ON financial_accounts (user_id, alert_source, alert_last4)
  WHERE deleted_at IS NULL AND alert_last4 IS NOT NULL;
CREATE UNIQUE INDEX idx_financial_accounts_alert_fwd
  ON financial_accounts (user_id, alert_source, alert_forwarded_from)
  WHERE deleted_at IS NULL AND alert_forwarded_from IS NOT NULL;
```

### 006 (Phase 3): merchants, review state, amount history

```sql
CREATE TABLE merchants (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  display_name     TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'ask_all'
                     CHECK (mode IN ('auto', 'ask_shortlist', 'ask_all')),
  category         TEXT,                       -- mode = auto
  shortlist        TEXT[] NOT NULL DEFAULT '{}',-- mode = ask_shortlist (1+ entries; "Other" is always offered)
  default_category TEXT,                       -- pre-selected; also the unattended guess
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  CHECK (mode <> 'auto' OR category IS NOT NULL),
  CHECK (mode <> 'ask_shortlist' OR cardinality(shortlist) >= 1)
);

CREATE TABLE merchant_aliases (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_key TEXT NOT NULL,               -- merchantKey(raw), see §5.5
  key_version    INTEGER NOT NULL,            -- MERCHANT_KEY_VERSION that produced it
  merchant_id    UUID NOT NULL,
  example_raw    TEXT NOT NULL,               -- one raw string as seen, for the Rules page and re-keying
  last_seen_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, normalized_key),
  FOREIGN KEY (user_id, merchant_id) REFERENCES merchants (user_id, id) ON DELETE CASCADE
);

ALTER TABLE transactions
  ADD COLUMN source             TEXT NOT NULL DEFAULT 'manual'
                                  CHECK (source IN ('manual', 'shortcut', 'email', 'csv')),
  ADD COLUMN review_status      TEXT NOT NULL DEFAULT 'confirmed'
                                  CHECK (review_status IN ('needs_review', 'confirmed')),
  -- Where the CURRENT category came from. 'guess' + needs_review = provisional
  -- (D2); 'guess' + confirmed = auto-filed by the unattended rule. Either way
  -- the UI marks it "unconfirmed" until a person picks.
  ADD COLUMN categorized_by     TEXT CHECK (categorized_by IN ('user', 'rule', 'guess')),
  ADD COLUMN reviewed_by        UUID REFERENCES users(id) ON DELETE SET NULL,  -- actor; display only
  ADD COLUMN reviewed_at        TIMESTAMPTZ,
  ADD COLUMN is_pending         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN original_amount    NUMERIC(14,2),
  ADD COLUMN merchant_id        UUID,          -- no FK; merges repoint it in the same transaction
  ADD COLUMN email_event_id     UUID,
  ADD COLUMN auto_merged        BOOLEAN NOT NULL DEFAULT false;   -- heuristic follow-up applied
-- A CONFIRMED expense/income always has a category. A needs_review row holds
-- its guess in `category` (D2), or NULL when Stash has no guess at all.
-- Transfers never carry a category (they can be needs_review: "which Venmo?", §5.12).
ALTER TABLE transactions ADD CONSTRAINT transactions_confirmed_has_category CHECK (
  kind = 'transfer' OR review_status = 'needs_review' OR category IS NOT NULL
);
-- The idempotency key for re-processing (C14): one event creates or links ONE row.
CREATE UNIQUE INDEX idx_transactions_email_event
  ON transactions (user_id, email_event_id) WHERE email_event_id IS NOT NULL;
CREATE INDEX idx_transactions_needs_review
  ON transactions (user_id, created_at) WHERE review_status = 'needs_review';
CREATE INDEX idx_transactions_pending
  ON transactions (user_id, account, occurred_at) WHERE is_pending;

CREATE TABLE transaction_amount_changes (
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
-- A retried follow-up can't apply twice.
CREATE UNIQUE INDEX idx_amount_changes_event
  ON transaction_amount_changes (user_id, transaction_id, email_event_id)
  WHERE email_event_id IS NOT NULL;
```

> **Check before writing 006:** run `SELECT count(*) FROM transactions WHERE
> kind <> 'transfer' AND category IS NULL`. The new CHECK assumes no existing
> expense lacks a category. If any do, backfill `'Misc.'` first (or drop the
> CHECK); don't discover this mid-migration.

### 007 (Phase 5): push, preferences, unattended

```sql
-- user_id here is the ACTOR, not the household scope, exactly like user_tokens:
-- a device belongs to a person. Scoping on the household would let each spouse
-- revoke the other's phone. Fan-out joins through users to reach the scope.
CREATE TABLE push_subscriptions (
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
CREATE TABLE notification_prefs (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  enabled    BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_id)
);

ALTER TABLE financial_accounts
  ADD COLUMN unattended_action TEXT NOT NULL DEFAULT 'keep_in_review'
    CHECK (unattended_action IN ('keep_in_review', 'auto_guess'));

ALTER TABLE transactions
  ADD COLUMN notified_at           TIMESTAMPTZ,
  ADD COLUMN unattended_due_at     TIMESTAMPTZ,
  ADD COLUMN unattended_settled_at TIMESTAMPTZ;
```

---

## 5. Components

### 5.1 Apps Script poller (`apps-script/`)

Files: `poller.gs`, `appsscript.json` (manifest: Gmail advanced service on,
explicit OAuth scopes `gmail.modify` + `script.external_request`), and
`README.md` (the paste-in steps). The script only moves email. All parsing lives
in Stash, so parsers can be fixed and old mail re-read without touching it.

- **Script Properties:** `STASH_URL`, `STASH_TOKEN`. Never in code.
- **`setup()`**, run once by hand: creates the labels `stash-processed` and
  `stash-rejected`, deletes any existing triggers, then installs `poll` (every
  1 min) and `heartbeat` (every 15 min). It's idempotent, so re-running it is
  how you repair a broken trigger setup.
- **`poll()`**:
  1. `LockService.getScriptLock().tryLock(0)`, or return. Runs can't overlap.
  2. `Gmail.Users.Messages.list('me', { q: 'in:anywhere -label:stash-processed
     -label:stash-rejected newer_than:7d', maxResults: 100 })`. That's
     **messages**, not threads (C15). Use 7 days rather than 3: the server dedupes,
     so a wider window is free, and it survives a long weekend outage.
  3. Load each with `GmailApp.getMessageById(id)`, sort ascending by date, take
     ≤25. Ordering is best-effort only; the server tolerates out-of-order
     follow-ups (§5.6).
  4. POST each one: `gmailMessageId`, `rfc822MessageId`, `from`, `to`, `subject`,
     `date` (ISO), `plainBody`, `htmlBody` (capped at 1 MB with a `truncated`
     flag), and headers `Delivered-To`, `X-Forwarded-For`, `X-Forwarded-To`,
     `Authentication-Results`, `ARC-Authentication-Results`, plus
     `pollerVersion`. Use `muteHttpExceptions: true`.
  5. Handle the response:

     | Response | Action |
     |---|---|
     | 2xx | Label the **message** `stash-processed` |
     | 401 / 403 | Stop the run (bad or revoked key; heartbeat will report it) |
     | 429 / 5xx / network error | Stop the run, label nothing (retried next minute) |
     | Other 4xx | Label `stash-rejected` and continue (a poison message can't block the queue) |
  6. Stop starting new messages after 45 s.
- **`heartbeat()`**: POSTs `{ pollerVersion, lastPollAt, lastError }`. Stash
  records it and runs the unattended settle (Phase 5).
- **Quota math:** consumer accounts get 90 min/day of trigger runtime. An empty
  run is roughly 0.5–1.5 s, and 1,440 runs/day comes to about 12–36 min. If the
  Apps Script **Executions** page shows more than 60 min/day, change `poll` to
  every 5 minutes.
- **Re-authorization:** if the Stash Gmail password changes, Google may require
  re-consent and the triggers stop. The heartbeat staleness warning (§5.10) is
  how you'd notice.

### 5.2 Ingest endpoint (`app/api/ingest/email/route.ts`)

Steps as in §3. These are the rules that make it safe:

- **Store first, then process.** `INSERT … ON CONFLICT (user_id,
  gmail_message_id) DO NOTHING RETURNING id`. On conflict, read the status. If
  it's terminal, return `200 { status, duplicate: true }`. If it's `received`,
  re-process (C14).
- **Parser bugs never cause a 5xx.** Every parse is wrapped. A throw becomes
  `unparsed` with `error` set, and the response is 200. A 5xx would make the
  script retry a deterministic failure every minute for a week.
- **5xx only for real infrastructure errors** (a DB failure), which are exactly
  the cases where a retry can succeed.
- **Atomic apply.** The transaction insert or update, the alias/merchant
  upsert, the amount-change row and the event's final status go in **one**
  `sql.transaction([...])`. Decisions are computed before the batch, because the
  Neon HTTP driver's transactions are non-interactive. The races this leaves
  (two writers between read and write) are closed by LockService on the poller
  plus the unique indexes.
- **Rate and size guard:** more than 120 events per minute in the scope returns
  429, and so does a body over 2 MB. The script's own cap is 1 MB, so this
  only ever stops a misbehaving client.
- **Never log request bodies.** A `console.log(payload)` would put bank email
  into Vercel logs.
- **Ignore list:** Gmail forwarding confirmations, Apps Script failure notices
  and Google account notices become `ignored`, never `unparsed`. Apps Script
  failure notices also raise the email-sync warning.
- **`/api/ingest`'s per-minute guard** currently counts every transaction in
  the scope. Change it to count `source = 'shortcut'` only, or a burst of email
  after an outage would 429 the Shortcut.

### 5.3 Parsers (`lib/email/parsers/`)

```ts
type ParsedAlert = {
  kind: "purchase" | "refund" | "declined" | "posted" | "amount_changed"
      | "payment_received" | "payment_sent" | "transfer";
  amountCents: number;           // positive integer; never floats
  merchantRaw: string;           // exactly as written
  accountHint: { last4?: string; name?: string };
  occurredAt: string | null;     // ISO when the body gives a time
  occurredDate: string | null;   // YYYY-MM-DD when it gives only a date
  isPending: boolean;            // true for authorization alerts
  counterparty?: string;         // Venmo
  memo?: string;                 // Venmo
  fundingSource?: { last4?: string; name?: string } | "balance";  // Venmo, if the receipt says (D4)
  previousAmountCents?: number;  // amount-changed alerts that state the old amount
};

type Parser = {
  id: string;                    // stored in financial_accounts.alert_source
  version: number;               // bump on any behavior change; stored per event
  senders: RegExp[];             // matched against the (unwrapped) From address
  dkimDomains: string[];         // DKIM must pass for one of these
  requireDkim?: boolean;         // default true; false needs a comment saying why
  parse(email: NormalizedEmail): ParsedAlert | { unparsed: string } | { ignore: string };
};
```

- **The registry is built first, with zero bank parsers.** Phase 1 ships it
  empty: every email is `unparsed`, and that is how real samples get collected.
- **Forwarded wrappers:** `lib/email/normalize.ts` recovers the original
  sender from a `---------- Forwarded message ---------` block when a bank's mail
  arrives that way. Gmail *filter* forwarding keeps the bank as `From:`, so this
  is the fallback, not the main path.
- **Never guess.** No amount, merchant (or Venmo counterparty) and account
  hint means `unparsed`. Declined alerts become `ignored` (with `parsed.kind =
  declined`) and never create a transaction.
- **Venmo specifics:**
  - "X requested $20" is a request, not money, so `ignored`.
  - "You paid X" is `payment_sent` (an expense on the Venmo account).
  - "X paid you" is `payment_received` (Income, D1).
  - A transfer to or from a bank is `transfer` (D4).
  - A counterparty in `internal_counterparties` is `ignored` (D6).
  - If a receipt names its funding source ("Visa ••1234"), extract it as
    `fundingSource`. Phase 2 samples will show whether Venmo's emails include it.
- **A payment *to* a credit card is `transfer`, never `refund`.** Under D1 a
  refund becomes Income, so misreading a card payment as a refund invents
  income. Fixtures must cover both cases for every card parser.
- **`occurred_at`:** if the body's date equals the email's local date (in the
  scope's timezone), use the email's exact timestamp. If the body gives only a
  different date, anchor it at 12:00 UTC (the repo convention in
  `resolveOccurredAt`). That keeps evening purchases in the right month.
- **DKIM:** require `dkim=pass` for one of the parser's domains in
  `Authentication-Results`, or the event is `unauthenticated`. This stops anyone
  who learns the Stash address from creating transactions or triggering pushes.
  *Verify in Phase 1* (acceptance check 7) that a Gmail-forwarded alert still
  shows the bank's DKIM pass. If one bank's doesn't, that parser sets
  `requireDkim: false` with a comment.

**Fixtures.** `lib/email/parsers/__fixtures__/<parser>/<case>.json` holds the
input email plus the expected `ParsedAlert`. A single test iterates every
fixture. There are also negative fixtures (a newsletter from the same bank, a
password-reset email) that must come out `unparsed` or `ignored`.

**Getting samples without hand-copying email:** once Phase 1 is live, real
alerts pile up in `email_events`.
`scripts/export-email-fixture.mjs <gmail_message_id>` pulls one, scrubs it
(names, street addresses, email addresses and balances become placeholders; each
real last-4 maps to a stable fake one), prints what it changed for you to
eyeball, and writes the fixture. Unscrubbed exports go to a gitignored
`__fixtures__/**/*.raw.json`.

### 5.4 Account resolution

1. `accountHint.last4` present: find the live account with `alert_source =
   parser.id AND alert_last4 = last4`. Exactly one can exist (partial unique
   index).
2. No last 4 (Venmo): find `alert_source = parser.id AND alert_forwarded_from =
   lower(forwarded_for or to)`.
3. Otherwise the event is `unknown_account`. **Never fall back to "the only
   account for this bank".** A replacement card or a new card would silently
   post to the wrong account.

Settings → Email sync lists unknown accounts like this: "Chase alerts for card
••4821 (3 emails) — which account?". Picking one sets the alert fields and
re-processes those events. That is also the flow when a bank mails a
replacement card.

### 5.5 Merchants and rules

**`lib/email/merchantKey.ts`** is pure, browser-safe (no `node:crypto`) and
versioned with `MERCHANT_KEY_VERSION`. Steps:

1. Uppercase, and fold `’'` (so `MCDONALD'S` becomes `MCDONALDS`).
2. Strip processor prefixes: `SQ *`, `TST*`, `PAYPAL *`, `PP*`, `SP *`, `POS `,
   `DEBIT CARD PURCHASE`, and so on.
3. Strip store numbers (`#4127`, a trailing ` 0412`), phone numbers, and URL
   noise (`AMAZON.COM*AB12C` becomes `AMAZON`).
4. Strip the trailing `CITY ST` pair.
5. Collapse whitespace.

It is tested with a table of real strings from fixtures and CSVs.

> **`merchantKey` is the new near-frozen function.** Aliases are keyed by its
> output, so changing it makes every known merchant look new and re-asks
> everything. A change requires bumping `MERCHANT_KEY_VERSION` and shipping
> `scripts/rekey-merchant-aliases.mjs` (recompute from `example_raw` plus
> `email_events.parsed->>'merchantRaw'`) **in the same commit**. Add that rule to
> `/CLAUDE.md`.

**Matching:** key → `merchant_aliases` → merchant. A miss creates a merchant
(mode `ask_all`, `default_category` = starter guess if one exists) and its alias.
The starter guesses live in `lib/email/config.ts` (`STARTER_GUESSES`: Maverik,
Chevron, Shell → Gas; Harmons, Macey's, Smith's → Groceries) and are editable in
code. **The first transaction is always asked.** Until someone answers, the guess
counts provisionally and is marked unconfirmed (D2).

**`decide` for a new transaction (pure, in `lib/email/rules.ts`):**

| Mode | Result |
|---|---|
| `auto` | `confirmed`, `category = merchant.category`, `categorized_by = 'rule'`, no push |
| `ask_shortlist` | `needs_review`, `category = default_category` (provisional, `categorized_by = 'guess'`), choices = shortlist + "Other" |
| `ask_all` | `needs_review`, `category = default_category ?? starter guess ?? NULL` (provisional when set) |

Money-in alerts skip this table entirely (D1, §5.12).

**Answering** (`POST /api/categorize/[id]` `{ category, always?, addToShortlist? }`):

- A conditional update: `… WHERE user_id = $scope AND id = $id AND
  review_status = 'needs_review' RETURNING …`. If zero rows come back, someone
  already answered: return `409 { category, reviewedByName }` and the screen
  shows "Already filed by Katie as Dates" with **Change**. Change goes through
  the existing `PATCH /api/transactions/[id]`, which already allows
  re-categorizing.
- Sets `review_status = confirmed`, `categorized_by = 'user'`, `reviewed_by =
  actorId`, `reviewed_at`.
- `always` sets the merchant to `auto` with that category. `addToShortlist` sets
  it to `ask_shortlist` and adds the category to the shortlist. If
  `default_category` is null, the answer becomes the default.
- **A guess never creates a rule.** Only an explicit `always` does.

**Rule changes never touch past rows**, unless the user picks **Apply to past
transactions**. That shows a count first ("Re-file 12 McDonald's transactions as
Eating Out — 3 of them you filed as Dates"), then updates them in one statement
scoped on `user_id AND merchant_id`.

**Merging two merchants** is one `sql.transaction`: repoint the aliases, repoint
`transactions.merchant_id`, then delete the source merchant. Every statement
filters on `user_id`.

### 5.6 Follow-up alerts: tips and gas holds

Thresholds live in `lib/email/config.ts` (`EMAIL_SYNC_CONFIG`) so they can be
tuned in one place:

```ts
followupWindowDays: 5, tipMaxIncreasePct: 35, tipMinGapHours: 12 /* D3 */,
gasHoldExactAmounts: [1.0], gasHoldRoundRange: [50, 200],
tipCategories: ["Eating Out", "Dates"], gasCategory: "Gas",
duplicateAlertWindowMinutes: 15, manualMatchWindowDays: 2,
csvSuggestWindowDays: 3, venmoCardMatchWindowDays: 1, heartbeatStaleMinutes: 30
```

**Candidates** are rows with the same account and same `merchant_id`, with
`is_pending = true` and an `email_event_id` set, occurring within
`followupWindowDays` before the new alert, **not claimed in reconciliation**
(C21), and not already updated by a posted alert.

| Rule | Ships in | Condition | Action |
|---|---|---|---|
| **Explicit** | Phase 3 | New alert is `posted` / `amount_changed`, with **exactly one** candidate | Set the new amount (if different), keep `original_amount`, `is_pending = false`, write the change row (`posted`, or `tip`/`gas_final` if the pattern fits, for the label). No push. Category kept. |
| Explicit, same amount | Phase 3 | Same as above, amount unchanged | Only `is_pending = false` |
| Explicit, ambiguous | Phase 3 | More than one candidate | **Create nothing** (it would double). The event goes to To categorize as "Which purchase did this update?" |
| Explicit, no candidate | Phase 3 | Zero candidates | A first sighting (some banks only send posted alerts): create normally, not pending |
| **Out of order** | Phase 4 | An authorization alert arrives *after* a posted-alert row for the same account and merchant within the window, within tolerance | `duplicate` of that row; nothing new |
| **Gas hold** | Phase 4 | Exactly one candidate. Its amount is exactly $1.00 or a round $50–200, the merchant files as Gas, and the **new amount isn't itself a hold** (C20) | Update, `auto_merged = true` |
| **Tip** | Phase 4 | Exactly one candidate, merchant files as Eating Out/Dates, new amount 0–35% higher, gap at least `tipMinGapHours` (D3) | Update, `auto_merged = true` |
| Anything else | — | — | A new, separate transaction |

**Split back into two** (any `auto_merged` row, from the transaction's detail)
restores `original_amount`, re-creates the second purchase from its own
`email_event` (possible only because raw events are kept), and logs
`split_back`. So every heuristic mistake is one tap to undo.

Pending rows that never get a second alert stay as they are, and the CSV pass
(§5.8) corrects them.

### 5.7 Dedupe matrix

Exactly one transaction per real purchase:

| Situation | Detection | Action | Phase |
|---|---|---|---|
| Same alert delivered twice: a Gmail redelivery, **or both spouses forwarding the joint card's alert** | Same account, kind, amount, merchant key, occurred within 15 min, different message id, and (identical `body_sha256` **or** a different `forwarded_for`) | Event `duplicate`, linked to the first row | 3 |
| Alert arrives **after** a Shortcut or web entry | Manual row (`source` manual/shortcut) with no `email_event_id`, ±2 days, amount equal (Phase 4: or within tip/gas tolerance), account equal **or** the manual row is on the default account (C18), **exactly one** candidate, not claimed | **Link:** set `email_event_id`, `merchant_id`, `is_pending`, and set the account to the alert's if the row was on the default. Keep the category and notes. No push. | 3 |
| Manual entry saved **after** the alert | In `/api/transactions` POST and `/api/ingest`: an email row ±2 days, same amount or tolerance, exactly one candidate | If the email row is still `needs_review`, **absorb it**: the manual entry *is* the answer (category applied, `reviewed_by = actor`), no second row, and the response says "Matched your card alert — **Keep both** instead?" If the email row is already confirmed, create the row and flag both as a "Possible duplicate" in To categorize. | 3 |
| Pending → posted | §5.6 | Update | 3 / 4 |
| Venmo funded by a bank or card (D4) | Bank/card alert whose merchant key is `VENMO` | Never an expense. It becomes, or dedupes into, the **transfer** bank/card → Venmo, while the Venmo email creates the expense. See §5.12. | 3 guard / 4 |
| Manual transfer vs email transfer (D4) | `kind = 'transfer'`, same amount ±2 days, same from/to (or the email row's still-unknown Venmo side) | Link; no second transfer | 4 |
| CSV bank line vs an email row | Existing `findMatches` (exact amount) + §5.8 tolerance pass | The existing claim | 4 |

The absorb and link logic lives in one function,
`insertOrLinkTransaction()` in `lib/transactions.ts`, which both write routes
call. It only runs when the scope's email sync is in `live` mode, and the kinds
must match: an expense pairs with an expense and income with income (D1, so a
hand-logged paycheck isn't doubled by its deposit alert). Transfers pair from
Phase 4 (D4). The shared `insertTransaction` stays a plain insert (extended
with optional `source`/review fields).

### 5.8 Reconciliation integration

- **Nothing in the matcher changes.** Email rows show up in Reconcile as
  user-inputted entries. They carry the correct account (from the last 4) and a
  real date, so `findMatches`' existing same-account exact branch auto-matches
  them *more* often than hand-logged rows. No new code is needed for that.
- **Additive row fields.** `EXPENSE_SELECT_FIELDS` gains `source`,
  `reviewStatus`, `isPending`, `originalAmount` and `categorizedBy`, and
  `SheetRow` gains the optional fields. These are additive, so existing
  consumers and the match-cache JSON are unaffected.
- **Pending-amount suggestion** (client-side, in `app/reconcile/page.tsx`, a
  separate pass over results with `unmatchedCategory = 'no_candidate'`):
  - A candidate is an unclaimed row with `isPending`, on the same account,
    ±`csvSuggestWindowDays`, where the bank amount is the logged amount ×1.00–1.35
    (tip categories) or the logged amount is a hold pattern (Gas).
    `merchantKey(bank description) === merchantKey(row's merchant)` raises
    confidence but isn't required.
  - Shown as "Pending card alert $14.82 · McDonald's — **Correct to $17.50 &
    link**". That runs `PATCH /api/transactions/[id] { amount, amountReason:
    'csv' }` (the route now logs to `transaction_amount_changes`), then the
    normal `handleApprove(match, userEntry)` claim.
  - It is **never** auto-applied and is excluded from bulk approve, so auto-match
    behavior is byte-identical to today.
- **"From alerts" filter chip** on the home view's `User-inputted: Needs review`
  list. These are email rows with no statement line yet, which covers "possible
  duplicates or cancelled holds" without a new screen.
- **Post-upload summary line** in account detail: matched · amounts corrected ·
  alert entries still unmatched · unchecked guesses (`categorized_by = 'guess'`).
- **Quick Add pre-fill (optional):** default the category from the merchant
  rule for `merchantKey(bank description)`.
- **`scripts/reparse-email-events.mjs --parser X [--apply]`** dry-runs current
  parsers over stored events and prints the diff (amount, date, merchant,
  account). `--apply` updates only rows that are unclaimed and whose amount
  wasn't changed manually. It is a script, not a button, because it rewrites
  history.

### 5.9 Push notifications and who gets them (Phase 5)

From the [[stash-ios-push-constraints]] investigation (re-verified 2026-11-15:
`@ducanh2912/next-pwa` exposes `customWorkerSrc`):

- **Service worker:** handlers go in `worker/index.ts`, which next-pwa compiles
  and `importScripts`es. **Never hand-edit `public/sw.js`**: it is generated.
  `runtimeCaching: []` stays.
  - `push` handler: **always** call `showNotification`. iOS revokes
    subscriptions that receive pushes without a visible notification, so there
    are no silent or data-only pushes, ever. `tag = transactionId`, so repeats
    replace rather than stack.
  - `notificationclick`: focus an existing client and navigate to
    `/categorize/[id]`, or `clients.openWindow` if there is none.
- **Server:** the `web-push` package, with `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in Vercel env. The client gets the
  public key from `/api/push/subscriptions` (GET), **not** a `NEXT_PUBLIC_`
  var, which would be inlined at build time. A 404 or 410 from the push service
  deletes that subscription row. Any other failure bumps `failure_count`.
- **Text:** "$14.82 at McDonald's · Joint Visa — Eating Out or Dates?" (for
  `ask_all`: "… — which category?"). That's the merchant display name, the
  amount and the account **name**, never a number.
- **Fan-out** (at ingest, live mode, decision `needs_review`):

  ```sql
  SELECT ps.* FROM push_subscriptions ps
  JOIN users u              ON u.id = ps.user_id
  JOIN notification_prefs np ON np.user_id = ps.user_id AND np.account_id = $account
  WHERE COALESCE(u.data_owner_id, u.id) = $scope AND np.enabled
  ```

  If there are recipients: send, then set `notified_at` and `unattended_due_at
  = now() + timeout`. If there are none: set `unattended_due_at = now()` and
  settle inline. A push failure is logged and **never** fails the ingest
  request. (If it did, the retry would re-ingest; ingest is idempotent, but the
  log noise isn't worth it.)
- **Not sent:** auto merchants, Income (D1), transfers including "which
  Venmo?" (D4), follow-up updates, declined alerts, linked or absorbed
  duplicates, unparsed mail (that only raises the badge).
- **Unattended settle** (`lib/email/unattended.ts`), called from the heartbeat
  and from every `GET /api/categorize`:
  - Overdue, unsettled `needs_review` rows on `auto_guess` accounts with a
    provisional category are confirmed as-is (`categorized_by` stays
    `'guess'`). The category doesn't change, so under D2 the budget doesn't
    move. The row leaves the queue and keeps its unconfirmed marker.
  - Everything else overdue is marked settled and stays in the queue, with no
    second push.
  - No default and no guess means it always stays in review, whatever the
    setting.
- **Settings → Notifications** (per person):
  - Device status: supported, installed to Home Screen, permission state.
  - An explainer screen **before** `requestPermission()`, because a denial is
    near-permanent on iOS and recovery means reinstalling the Home Screen app.
  - Per-account toggles, **Send test notification**, and (shared) the answer
    timeout.
- **A new account is on only for whoever created it**: `POST /api/accounts`
  inserts the creator's `notification_prefs` row.
- **Sign-out** (`SignOutButton`) unsubscribes the device's push subscription and
  deletes the row, so a shared phone stops receiving the previous person's
  pushes. This avoids any cross-user delete by endpoint.
- **It cannot be tested in dev** (`disable` in development). Every iteration
  needs a deployed build on a real iPhone Home Screen app. Ship it to
  production behind the per-person Enable button: nobody gets a push until they
  opt in, so production is a safe test bed.

### 5.10 UI surfaces

| Surface | Where | Phase |
|---|---|---|
| **Email sync** section: create or revoke the email key (shown once), last check-in, last email, counts by status, link to the setup guide, shadow/live switch | `/settings` → `components/EmailSyncPanel.tsx` | 1 (switch enabled in 3) |
| Email activity: recent events (metadata only, **never bodies**) with status filters. "Couldn't read" and "Unknown account" lists, **Re-read** button (re-runs `unparsed` / `unknown_account` events with current parsers; never `unauthenticated`, never `shadow`) | `/settings/email-sync` | 1 (list) / 2 (actions) |
| Staleness warning: amber after 30 min with no heartbeat. A banner on New Expense after 6 h (since nobody visits Settings) | Settings + `CategorizeBanner` | 1 |
| Account alert fields (bank, last 4 / forwarded-from) | `ManageAccountsModal` | 2 |
| Shadow report: "would have created $X · Merchant · Account", next to the manual entries from the same days | `/settings/email-sync` | 2 |
| **To categorize** list (newest first; chips: All · Guessed · Possible duplicates), badge count | `/categorize` | 3 |
| Categorize screen: big shortlist/guess buttons, **Other** opens the full category grid, "Always file it this way?" and "Add to shortlist" toggles, "updated from $X" note, Already-filed state | `/categorize/[id]` | 3 |
| Count banner (D5) | Top of New Expense + Budget, `components/CategorizeBanner.tsx`. The list itself is `components/CategorizeQueue.tsx`, so it can later move into Reconcile (D5) | 3 |
| **Unconfirmed marker** (D2) for any row whose category no person chose (`needs_review`, or `categorized_by = 'guess'`). Budget bars draw that share as a lighter, hatched segment of the category's colour, labelled "incl. $X unconfirmed". Transaction lists and the Reconcile entry subtitle show a dotted "unconfirmed" chip that opens `/categorize/[id]` | Budget dashboard, category drill-down, Reconcile, To categorize | 3 |
| "Awaiting category · $X" line, for **only** the rows with no guess at all | Budget dashboard | 3 |
| Rules page: merchants, mode, category/shortlist, default, raw names, last seen, count; edit, merge, move a raw name, apply to past | `/rules` (linked from Settings + categorize screen) | 3 |
| Setup checklist (the source plan's steps 1–4, plus §7's gotchas) | `docs/email-sync-setup.md` + in-app `/guide/email-sync` (mirrors `/guide/reconcile`) | 1 |
| Unattended setting per account | `ManageAccountsModal` | 5 |
| Notifications section | `/settings` | 5 |

**Phase 3 audit:** `expenseType` can now be `""` (no guess) on real expense
rows, and a category can now be provisional (D2). So `reviewStatus` and
`categorizedBy` must reach every place that renders a category. Grep every
consumer and verify each one: `app/page.tsx`,
`app/reconcile/page.tsx` (the edit modal and category dropdowns),
`services/accountBalancesService.ts` (it branches on `'Income'`; a null category
correctly reads as money out), and the budget page.

### 5.11 Security

- **Token purpose separation.** A leaked email key can't log arbitrary
  transactions through `/api/ingest`, and a Shortcut token can't post email.
  Both are revocable from Settings.
- **DKIM gate** on every parser (§5.3).
- **Raw bodies never leave the server.** No route selects
  `raw_text`/`raw_html`. Debugging uses the export script locally.
- **No request-body logging** in ingest routes (§5.2).
- **Push payloads** carry the merchant, amount and account **name** only.
- **Never store card numbers.** Parsers extract the last 4 and nothing else.
  Raw emails contain only what the bank sent.
- **Stash Gmail hygiene** (from the source plan): a unique password and 2-Step
  Verification. The account holds every purchase both of you make.
- **Rate and size limits** on the ingest route (§5.2).

### 5.12 Money in (D1) and Venmo transfers (D4)

**Money-in classification (D1).** Each money-in alert takes the first row that
matches:

| Alert | Becomes |
|---|---|
| Counterparty in `internal_counterparties` (D6) | `ignored` |
| Bank/card alert whose merchant key is `VENMO`, or a Venmo "transfer to bank" email | A Venmo leg (below), not income |
| A payment *to* a credit card ("payment received, thank you") | `transfer` kind. **Since 2026-11-16** a transfer row (see "Account transfers" below); before that `ignored`, left to Reconcile |
| Venmo "X paid you" / "X completed your request" (**since 2026-11-16**) | A **transfer** from `"Other"` into that Venmo account, confirmed, described by the note. Someone paying you back isn't income — Daniel's convention. Links to a hand-logged transfer; never pairs with another person's payment of the same amount |
| Refund or credit, deposit | `kind = 'income'`, `category = 'Income'`, `review_status = 'confirmed'`, `categorized_by = 'rule'`. No question, no push. A refund reads "Refund · Amazon". **Since 2026-11-19** a deposit is described by its *source* alone, like a hand-logged paycheck ("Acme"): the source becomes a merchant row, listed under Rules → **Money in**, where renaming it names every later deposit. Its category settings never apply |

Income rows go through `insertOrLinkTransaction`, so a paycheck already logged
by hand gets linked, not doubled. In Reconcile they're ordinary Income
entries, and they match the deposits that today land in the `income` unmatched
bucket.

**Venmo legs (D4).** This is the model the app already uses for money moving
between two of your own accounts: one **transfer** row (`transfer_from` →
`transfer_to`), plus, for a payment, one **expense** on the Venmo account.

| Arrives | Action |
|---|---|
| Venmo "You paid Alex $20" | Expense on that Venmo account (merchant = counterparty, memo in the description), with the normal category flow. Created whatever funded it |
| Bank/card alert, merchant `VENMO`, money out | Transfer bank/card → Venmo |
| Bank alert, merchant `VENMO`, money in, or a Venmo "transfer to bank" email | Transfer Venmo → bank |
| A Venmo receipt naming an external `fundingSource` (if Venmo includes one; confirmed in Phase 2) | Also creates the transfer, unless the bank's alert already did |
| Whichever transfer source arrives second | `duplicate` of that transfer (same from/to, same amount, ±`venmoCardMatchWindowDays`) |

For a card-funded $20 payment, the result is: the card's balance moves $20,
Venmo goes +20 then −20, and the budget sees one $20 expense.

**Which Venmo account?**
- If the scope has exactly one live account with `alert_source = 'venmo'`, use
  it.
- If there are several, pair the transfer with the Venmo email of the same
  amount ±1 day: `payment_sent` for money out, the "transfer to bank" email for
  money in.
- If the bank alert arrives first, the transfer is created with its Venmo side
  unset and `review_status = 'needs_review'`, and it shows in To categorize as
  "Which Venmo account?". When the matching Venmo email lands, the side fills
  in and the row confirms automatically. There is no push for this.

**Descriptions must contain "Venmo"** ("Venmo transfer", "Venmo cash-out").
Reconcile's transfer step (`findMatches` step 3) needs the bank line to look
like a transfer, which `isLikelyTransferDescription` already does for `venmo`.
It also needs a description Jaccard ≥ 0.12 against the logged row. With no
matcher change, email transfers reconcile exactly like hand-logged ones, with
one or two legs as today.

**Phase split.** In Phase 3, every Venmo-leg alert is recorded as `ignored`
(`status_reason = 'venmo_leg_pending_phase4'`) and creates nothing. The Venmo
*expense* is still created, so the budget is right from day one. Only the
transfer's balance movement waits for Phase 4, and the CSV covers it until
then.

**Account transfers (added 2026-11-16, Daniel's request).** Card payments and
moves between your own accounts were "Not doing (now)"; they now follow the
Venmo-leg model above with the same `decideTransfer`:

| Arrives | Action |
|---|---|
| A bank/card alert of kind `transfer` naming both accounts (Wells Fargo "You made a payment", "Online transfer") | One confirmed transfer row. "Card payment" when the `to` account is a credit card, else "Transfer" — both words Reconcile's transfer step already looks for |
| One that names an account Stash doesn't know (or none, e.g. a card's "payment received") | Created with that side unset, `needs_review`, "Which account?" in To categorize. No push |
| The other bank's email for the same movement (same amount, ±`transferMatchWindowDays`, one side equal) | `duplicate`, or fills the unknown side and confirms |
| A hand-logged transfer of the same amount and accounts (±`manualMatchWindowDays`) | `linked`; no second row |
| A second email of the *same* type (same kind, same merchant key) | A separate transfer — two $500 savings transfers in a week are two — unless it is the same email again (identical body, or the other inbox's copy) |
| An email naming the same account on both sides | `ignored` (`transfer_same_account`) |
| The other half of a card payment where **each email names only its own side** — the bank's "CAPITAL ONE ONLINE PMT" (no card) and the card's "payment received" (no paying account) — in either order (**since 2026-11-19**) | Completes the waiting one (`completed_transfer_side`). Only into a credit card, and only when exactly one is waiting |

**Posted-activity summaries (since 2026-11-19).** Wells Fargo's "Your account
update is here" lists posted Deposits and Withdrawals for one account — the
only place a checking withdrawal like "CAPITAL ONE ONLINE PMT", an ACH
donation or an autopay shows up. One email can list several, and everything
downstream is one transaction per event, so the pipeline splits it into child
events `<gmail id>#1…#n` (`lib/email/parts.ts`): full copies with their own
body hash and status, of which the parser reads only its own line. A summary
mostly repeats what other alerts and hand entries already recorded, so each
line (`postedSummary`) first checks `alreadyRecorded`: anything on that
account with the same amount and direction within ±`postedSummaryMatchDays`
(5) is `duplicate`, or `linked` if it was hand-logged. Only news creates
anything:

| Line | Becomes |
|---|---|
| Withdrawal to a card issuer ("CAPITAL ONE … PMT", "DISCOVER … PAYMENT", …) or an online transfer | A transfer from the account; the other side is the one it names by last 4, or the card's own "payment received" email, or "Which account?" |
| Deposit reading "REWARDS" | A confirmed transfer from "Other" — Daniel's convention for rewards (how they were logged by hand), like a Venmo payback |
| Any other withdrawal (an ACH donation, an autopay, a check) | An expense on that account that asks for a category |
| Any other deposit | Income, named by its source |

The bias is deliberate: two genuinely separate same-amount items on one
account within five days, one of them already recorded, leave the second to
Reconcile rather than risk doubling every Bill Pay and card payment.

**Alerts that name no account** (migration 008). Wells Fargo Bill Pay says
only "your selected account(s)". Such an alert routes to the single account
ticked "Bill Pay comes out of this account" (`alert_unnumbered`); with none
ticked it waits under Unknown account, where assigning it ticks the box.

---

## 6. Build phases

Each phase has its own migration, its own acceptance checks, and a rollback that
touches no existing data. **Don't start a phase until the previous one's checks
pass.** `next build` must pass and `scripts/check-schema.mjs` must be clean at
the end of every phase.

### Phase 0: Prep (Daniel; no code)

- [ ] Create the Stash Gmail account with 2-Step Verification.
- [ ] Confirm the production URL and that Vercel deploys `main` (the Apps
      Script needs a public HTTPS URL; `AUTH_URL=localhost` is dev only).
- [ ] Check the Neon plan's storage limit against C24's estimate.
- [ ] Skim D1–D6. The defaults are fine to start on.
- Bank samples are **not** needed yet. Phase 1 collects them.

### Phase 1: Ingest pipeline (store only). Size: M

**Build**
- Migration 004.
- `lib/apiAuth.ts`: `requireUser(req, { bearerPurpose })`, with the purpose in
  `identityFromBearer`'s `WHERE`. `/api/ingest` and `/api/ingest/accounts` pass
  `'shortcut'`.
- `/api/tokens` POST accepts `purpose` and GET returns it.
  `ShortcutSetupCard` filters to `shortcut`.
- `/api/ingest/email`: store, ignore list, everything else `unparsed`
  (`no_parser`). Plus `/api/ingest/email/heartbeat`.
- `apps-script/` (poller, manifest, README).
- `EmailSyncPanel` in Settings, plus `/settings/email-sync` (list only).
- `docs/email-sync-setup.md` and `/guide/email-sync`.
- `scripts/post-test-email.mjs`: POST a fixture to any base URL with a token.
  This is the dev loop, since Apps Script can't reach localhost.
- Test runner: add `vitest` (dev dependency, config aliasing `@/`) and an
  `npm test` script. Update the "No test suite" line in `/CLAUDE.md`.

**Done when**
1. A test email sent to the Stash inbox appears in `/settings/email-sync` within
   2 minutes (`unparsed`, `no_parser`).
2. Removing that message's `stash-processed` label in Gmail makes the next run
   re-POST it, and no second row appears (`duplicate: true`).
3. Three alerts with the same subject (which thread together) produce **three**
   rows.
4. Revoking the email key gives a 401, the messages stay unlabeled, and Settings
   shows the heartbeat error. A new key catches up the backlog.
5. The Shortcut still logs. The email key is rejected by `/api/ingest`, and a
   Shortcut token is rejected by `/api/ingest/email`.
6. Killing the request between the event insert and completion (simulate it
   with a thrown error after step 2) leaves the event `received`, and the retry
   completes it.
7. A bank alert **forwarded by a Gmail filter** from Daniel's inbox shows
   `forwarded_for` set **and** `dkim=pass` for the bank's domain in
   `auth_results`. (This de-risks the DKIM gate before Phase 2 depends on it.)
8. Settings shows the last check-in time. Disabling the triggers turns it amber
   after 30 min.

**Rollback:** delete the triggers and revoke the key. No existing data is touched.

**Then:** turn on alerts at each bank (the source plan's setup steps 2–3) and
let real mail collect for 1–2 weeks.

### Phase 2: Parsers, in shadow mode. Size: M + S per bank

**Build**
- Migration 005.
- Registry, `normalize.ts`, `occurredAt.ts`, the DKIM check.
- One parser per bank Daniel has alerts from, plus the Venmo parser
  (requests ignored, D6 internal counterparties).
- `scripts/export-email-fixture.mjs` (with scrubbing) and the fixture harness.
- Alert fields in `ManageAccountsModal`. Account resolution and the
  unknown-account assign → re-process flow.
- `decide()` (Phase 2 subset: parse, resolve, would-create) and the **shadow
  report**.
- "Couldn't read" list with badge and the **Re-read** button.

**Done when**
1. Every fixture parses to the right kind, amount, merchant, account hint and
   date (`npm test`).
2. An unknown sender lands in "Couldn't read". A card ••0000 with no matching
   account lands in "Unknown account", and assigning it re-processes the event.
3. A spoofed alert (sent from a personal address with a bank-looking body)
   is `unauthenticated`.
4. **One week of shadow output matches reality**: every real purchase alert
   appears in the shadow report with the right amount and account, checked
   against what was logged by hand. This is the gate for writing real data.

**Rollback:** remove parsers from the registry. Shadow mode writes nothing
outside `email_events`.

### Phase 3: Merchants, rules, To categorize, go live. Size: L

**Build**
- Migration 006 (after the null-category check in §4).
- `merchantKey.ts` with its table tests, `STARTER_GUESSES`, `rules.decide`, the
  full `decide()`/`apply()`.
- Duplicate-alert detection, **explicit** follow-ups, `insertOrLinkTransaction`
  (both dedupe directions, expense and income), and the `source`-scoped
  Shortcut rate guard.
- Money-in → Income (D1, §5.12).
- The D4 guard: bank/card alerts with merchant `VENMO` and Venmo↔bank transfer
  emails are recorded `ignored` (`venmo_leg_pending_phase4`), never an expense
  or income.
- `/categorize`, `/categorize/[id]`, `/api/categorize`, and `/rules` with
  `/api/merchants` (edit, merge, move alias, apply-to-past).
- `CategorizeBanner`, `CategorizeQueue`, the **unconfirmed marker** (D2), the
  dashboard Awaiting line (no-guess rows only), and the additive row fields.
- The `expenseType = ""` audit (§5.10).
- The live switch in Settings. **Switching to live never backfills shadow
  events**: those purchases were logged by hand during shadow.

**Done when**
1. *(source plan)* After one "Always file as Groceries", the next Smith's
   alert files as Groceries with no prompt.
2. *(source plan)* A McDonald's alert waits in To categorize offering only
   Eating Out and Dates (plus Other). If the merchant has a default, it already
   counts in that bar, marked unconfirmed (D2).
3. Shortcut-log $12.40, then the alert arrives: **one** row, the Shortcut's
   category, and the account corrected from default to the card.
4. Alert first, then Shortcut-log the same purchase: **one** row, answered by
   the Shortcut entry. **Keep both** restores two rows.
5. The same joint-card alert forwarded from both inboxes produces one row.
6. A pending alert followed by a posted alert with a new amount produces one row
   at the posted amount, with "updated from $X".
7. Both people answer the same item: the second sees "Already filed by
   Daniel/Katie as …".
8. The Budget dashboard's total equals the sum of its category bars (with
   their unconfirmed shares) plus the Awaiting line.
9. Switching shadow → live creates no rows from old shadow events.
10. A guessed purchase shows the unconfirmed marker on its bar, in the category
    drill-down and in Reconcile. Answering with a different category moves the
    amount to that bar and clears the marker.
11. A refund alert and a Venmo "X paid you" each create a confirmed `Income`
    row with no prompt. A card-payment alert creates nothing.
12. A card alert for `VENMO` creates no expense, while the matching Venmo
    "You paid" email does create one (D4 guard).

**Rollback:** switch back to shadow. Email rows already written stay as normal
logged entries (they're real purchases), and nothing else depends on them.

### Phase 4: Heuristic follow-ups and CSV tolerance. Size: M

**Build**
- Migration: none (006 covers it).
- Gas-hold and tip heuristics (D3), out-of-order handling, Split back into two.
- Venmo transfers (D4, §5.12): both arrival orders, "Which Venmo account?"
  resolution, and manual-transfer linking.
- `PATCH /api/transactions/[id]` logs amount changes with a reason.
- The Reconcile pending-amount suggestion, the From-alerts chip and the
  post-upload summary line. Optionally, Quick Add pre-fill.
- `scripts/reparse-email-events.mjs`.

**Done when**
1. *(source plan)* A $1.00 gas hold followed by a $43.17 final alert leaves one
   transaction of $43.17 in its original category.
2. Two fill-ups at the same Maverik two days apart stay **two** transactions,
   and so do two $1.00 holds.
3. Two dinners at the same restaurant in one week stay two, or, if D3 merged
   them, **Split back into two** restores both with the right amounts.
4. *(source plan)* A CSV upload of an already-captured month creates no
   duplicates. **Also:** re-uploading an old, fully reconciled month gives the
   *identical* matched count to before this phase. That proves `findMatches`
   behavior is unchanged.
5. A tipped bank line shows "Correct to $X & link", and accepting it writes a
   `csv` amount change and a normal claim.
6. A card-funded $20 Venmo payment produces exactly one $20 expense on Venmo
   and one $20 transfer card → Venmo, whichever email arrives first. The card
   balance moves $20, the Venmo balance nets to $0, and the budget shows $20
   once.
7. A Venmo payment from the Venmo balance produces only the expense. A Venmo
   cash-out produces a transfer Venmo → bank and **no** Income.
8. With two Venmo accounts and the bank alert first, the transfer waits as
   "Which Venmo account?" and resolves itself when the Venmo email arrives.
9. The bank's CSV line for that Venmo debit reconciles against the email
   transfer through the normal transfer claim.

**Rollback:** set the heuristic flags in `EMAIL_SYNC_CONFIG` to off. The
Reconcile additions are display-only.

### Phase 5: Push notifications. Size: L (mostly the deploy-and-test loop)

**Build**
- Migration 007.
- `worker/index.ts`, `web-push`, VAPID env (and `.env.example`), `lib/push.ts`.
- `/api/push/subscriptions` (GET key, POST, DELETE), `/api/push/test`, and
  `/api/notifications/prefs`. All are session-only and scope on `actorId`.
- Settings → Notifications.
- Fan-out at ingest, the unattended settle in the heartbeat plus lazily, and the
  unattended setting in `ManageAccountsModal`.
- New account subscribes its creator. Sign-out unsubscribes.

**Done when**
1. *(source plan)* Daniel is subscribed to everything except Katie's Venmo,
   and Katie only to her Venmo. A joint-card Ask purchase notifies Daniel only,
   and a Venmo Ask payment notifies Katie only.
2. *(source plan)* An Ask purchase left unanswered past the timeout follows its
   account's unattended setting. Auto-guessed rows carry the "guessed" tag and
   appear under the Guessed chip.
3. *(source plan)* Tapping a notification opens that transaction's
   categorize screen, from a cold start and from the app already open.
4. **Send test notification** arrives. A denied permission shows the reinstall
   instructions.
5. After signing out on a phone, that phone gets no more pushes.
6. Removing Katie from the household stops her pushes for Daniel's accounts,
   with no other change.
7. A dead endpoint's row is gone after the next send.

**Rollback:** remove the Enable button. Subscriptions sit inert.

---

## 7. Failure modes and how each one surfaces

| Failure | How you'd know | Safeguard |
|---|---|---|
| Trigger stops (re-auth needed, quota, Google outage) | Amber "last check-in" in Settings; a New Expense banner after 6 h | Heartbeat |
| Stash down or returning 5xx | Messages stay unlabeled and retry every minute for 7 days | `newer_than:7d` + idempotent ingest |
| Request dies mid-processing | The event stays `received` | Resume on retry (C14) + unique `email_event_id` |
| Parser throws | `unparsed` with the error, badge count | Catch-all; never a 5xx |
| Bank changes its email template | A spike in "Couldn't read" | Fixture tests, fix, **Re-read** |
| New or replacement card | "Unknown account" list | Assign → re-process; no silent fallback |
| Spoofed bank email | `unauthenticated` | DKIM gate |
| Threaded alerts | — | Per-message labels (C15) |
| Same alert twice / both spouses forward | `duplicate` | §5.7 fingerprint |
| Wrong heuristic merge | "auto-merged" tag; the CSV shows an unmatched line | Split back into two |
| Normalizer change orphans aliases | Known merchants re-asked | Key version + re-key script in the same commit |
| Push subscription dies | `failure_count`, test button | Prune on 404/410 |
| iOS permission denied | Settings shows the state and how to recover | Pre-prompt explainer |
| Nobody answers | Overdue → settled | Timeout + per-account setting |
| Shared phone after sign-out | — | Unsubscribe on sign-out |
| Shortcut 429 after an email burst | — | Rate guard scoped to `source = 'shortcut'` |
| Bank email in Vercel logs | — | No body logging (code review rule) |
| Card payment misread as a refund, inventing Income (D1) | An Income spike; Reconcile shows the line unmatched | Parser rule + fixtures for both cases (§5.3) |
| Venmo cash-out booked as Income | — | Venmo legs are classified before money-in (§5.12 table order) |
| Guess counted under the wrong category (D2) | Unconfirmed marker on the bar | One tap to To categorize; answering moves it |
| Storage growth | Neon dashboard | lz4; an optional "purge HTML older than N days" job later |

---

## 8. Testing

- **Unit (`npm test`, Vitest):** parsers via fixtures; the `merchantKey` table;
  `rules.decide`; follow-up matching (every row of §5.6's table, including
  the "must not merge" cases); the dedupe matrix; money-in classification
  (refund vs. card payment vs. Venmo cash-out, §5.12's table order); Venmo
  transfer pairing in both arrival orders; `occurredAt` around midnight
  and month boundaries; the payload validator. All of these are pure, which is
  the point of the `decide`/`apply` split.
- **Integration (dev):** `scripts/post-test-email.mjs` against `localhost:3000`
  with a dev email key. It replays fixtures through the real route and database.
- **Acceptance:** each phase's "Done when" list, by hand in a browser (per
  `/CLAUDE.md`). Phase 5 runs on production and a real iPhone.
- **Regression:** Phase 4 check 4 (identical matched count on an old month) is
  the guard that the reconciliation surface didn't move.

---

## 9. Docs to update as phases ship

- `/CLAUDE.md`:
  - The bearer surface (four routes, token purposes).
  - New invariants: `merchantKey` stability; the ingest never 5xxs on a parse;
    no body logging; follow-ups never touch claimed rows.
  - Settings now also holds Email sync and Notifications (C22).
  - New tables in Key Files; category count 15 → 16; the test runner.
- `app/reconcile/CLAUDE.md`: the pending-amount suggestion and why it lives
  outside `findMatches`.
- `docs/neon-setup.sql`, `docs/migrations/004–007`, `scripts/check-schema.mjs`
  (`USER_SCOPED` gains the scope tables, and the two actor-scoped tables get the
  same treatment and comment as `user_tokens`).
- `.env.example`: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- `docs/email-sync-setup.md` + `/guide/email-sync`.

---

## 10. Open items for Daniel

From the source plan, still open:
- [ ] List of banks, cards and other accounts (Venmo, etc.), and the unattended
      setting for each.
- [ ] For each bank: can it send alerts directly to another address, or does it
      need Gmail forwarding?
- [ ] Create the Stash Gmail account. (Its address goes into the Apps Script's
      setup, not the repo.)
- [ ] Confirm the starter guess list. Category names are confirmed from code:
      Gas, Groceries, Eating Out and Dates all exist.
- [ ] Is Katie's phone an iPhone or Android? (It changes only Phase 5
      testing; web push works on both.)

Changed or new:
- [ ] ~~One sample alert email per bank~~. No longer needed up front: Phase 1
      collects real ones and `export-email-fixture` scrubs them.
- [x] D1–D6, answered 2026-11-15 (§2).
- [ ] When enrolling alerts on a **joint** card, only **one** of you enrolls.
      The duplicate detector catches double enrollment, but avoiding it is
      cleaner.
- [ ] Neon storage limit (Phase 0).

## 11. Build notes (2026-11-15)

Where the code departs from, or settles something this document left open.
Each item follows the tie-break rule (conform to what exists) unless it says
otherwise.

**Schema additions beyond §4**
- `email_events`: `arc_auth_results` (the DKIM gate's ARC fallback needs it
  on re-read), `truncated`, and `mode_at_receipt` (Re-read never upgrades a
  shadow-era email to live, which makes "switching to live never backfills" hold
  for re-reads too). Status `ambiguous` was added for "Which purchase did this
  update?", because §5.6 says such an event creates nothing and waits for a
  person, which needs a terminal status of its own.
- `email_sync_settings`: `last_poll_at` and `last_poller_failure_at` (set when an
  Apps Script failure notice arrives, §5.2).
- `transactions.duplicate_of`: the "Possible duplicate" flag from §5.7 needed
  somewhere to live. It's display-only and cleared by Keep both or a delete.
- Migration 006 runs in one transaction and refuses to start if any
  expense lacks a category (the §4 pre-check, built in). The production
  database had **0** such rows on 2026-11-15.

**Behaviour**
- An oversized body returns **413, not 429** (§5.2). The poller labels any 4xx
  other than 401, 403 and 429 as rejected, so a permanently oversized message
  can't block the queue the way a 429 would.
- The Apps Script reads mail through the **Advanced Gmail service only**
  (`Messages.get`, format `full`), not GmailApp. That keeps the OAuth scope at
  `gmail.modify` and sends the *first* (Gmail-added) Authentication-Results
  header.
- `categorized_by` is `NULL` for anything a person typed. That covers every
  pre-existing row, so the migration rewrites nothing. A category edit through
  `PATCH /api/transactions/[id]` on a guessed or waiting row becomes `'user'`.
- An email row's category answered by absorbing a manual entry also sets
  that merchant's default when it has none, the same as a categorize answer.
- With no Venmo account in the scope, a card alert for Venmo becomes a transfer
  to the **external label "Venmo"**. It's confirmed, not "Which Venmo
  account?": the card balance moves, and nothing waits for an answer that can't
  come.
- The transfer a Venmo receipt creates (card → Venmo) can't carry the
  receipt's event id, because that id already belongs to the expense under the
  unique index. It gets an id derived from the event instead, which keeps a
  retry idempotent.
- Phase 3's guard and Phase 4's Venmo transfers both ship, behind
  `EMAIL_SYNC_CONFIG.enableVenmoTransfers`. Setting it to false records every
  Venmo leg as `ignored` (`venmo_leg_pending_phase4`), exactly as Phase 3
  specifies. The same file holds the other Phase 4 rollback switches.
- Reconcile's Quick Add sends `source: "csv"` and always inserts a plain row
  (see `app/reconcile/CLAUDE.md`).
- `/api/ingest` answers **201** even when the Shortcut entry absorbed a card
  alert, because the existing Shortcut may check the status code. The body
  gains `matchedCardAlert` and `possibleDuplicate`.

**Not built (needs real mail first)**
- Bank parsers. The registry ships with Venmo only. Venmo's v1 is written from
  Venmo's published subject formats, and its fixtures are marked
  `"synthetic": true`. Add each bank with `npm run email:export` →
  `lib/email/parsers/_template.ts` → `npm test` → register.
- `scripts/rekey-merchant-aliases.mjs` is only needed alongside a
  `merchantKey` change (invariant 7). It isn't written yet.

## Not doing (now)

- AI extraction fallback (later; results would always go to review).
- Android notification action buttons.
- Refunds as negative expenses: D1 chose Income instead.
- ~~Non-Venmo transfer alerts (card payments, account-to-account)~~ — built
  2026-11-16, see "Account transfers" in §5.12.
- User-defined categories.
- Moving To categorize into Reconcile (D5, "maybe later"): `CategorizeQueue`
  is built to be re-mounted there.
- If the deferred 70% budget alert gets built, decide whether unconfirmed
  amounts count toward it. Under D2 they already count in the bars. Monthly reconcile reminder and 70% budget alerts: still deferred
([[push-notifications-deferred]]), but Phase 5's push infrastructure makes each
of them a small follow-up.
