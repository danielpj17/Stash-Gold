# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server at http://localhost:3000
npm run build    # Production build (also runs typecheck)
npm run start    # Run production build
node scripts/check-schema.mjs   # Verify the DB matches docs/neon-setup.sql
```

```bash
npm test                         # Vitest: pure email-sync modules (parsers, merchantKey, decide…)
npm run email:post -- <fixture>  # POST a fixture email to /api/ingest/email (needs STASH_TOKEN)
npm run email:export -- <gmail_message_id>   # scrub a real alert into a parser fixture
npm run email:reparse -- --parser <id> [--apply]  # dry-run current parsers over stored events
```

`npm test` covers only the pure email-sync modules (`lib/email/**/*.test.ts`)
and the dashboard's budget-load retry rule (`lib/budgetLoad.test.ts`);
everything else is verified manually in the browser. `npm run lint` is present
but there is **no ESLint config checked in**, so `next lint` just prompts for
setup; `next build` is the real typecheck gate.

**`AUTH_URL` is pinned to `http://localhost:3000`.** If port 3000 is taken,
`next dev` silently falls back to 3001 and magic-link callbacks break. Stopping
the `npm` wrapper often leaves the `next dev` child alive holding the port, so
check for orphans before assuming a restart worked.

## Environment Setup

Copy `.env.example` to `.env.local` and populate `DATABASE_URL`, `AUTH_SECRET`,
`AUTH_URL`, and the Gmail SMTP vars. `EMAIL_SERVER_PASSWORD` must be a Gmail
**App Password** (needs 2-Step Verification), not an account password.

**Run `docs/neon-setup.sql` once against a fresh Neon database before first
sign-in** — sessions live in that database, so nothing works until it exists.
That file is the single source of truth for the schema; API routes no longer
create tables at request time.

For a database created from an older copy of that file, apply everything in
`docs/migrations/` in order. `scripts/check-schema.mjs` names the migration to
run when it finds a missing column or index.

`NEXT_PUBLIC_SHORTCUT_ICLOUD_URL` is optional and read **client-side**, so it is
inlined at build time — changing it needs a rebuild, not a restart.

## Architecture

**Stash** is a multi-user Next.js 14 personal finance dashboard. All data lives
in **Neon Postgres** — transactions, budgets, accounts, reconciliation state,
and Auth.js sessions. There are no external data systems. (Transactions used to
live in Google Sheets, and there was a SnapTrade brokerage integration; both are
fully retired.)

### Non-negotiable invariants

These are the rules that keep the app correct. Break one and the damage is
silent and expensive.

1. **Every table holding user data carries `user_id`, prepended to its primary
   key and to every UNIQUE constraint.** Every query filters on it — including
   inside `NOT EXISTS` subqueries, and especially every `DELETE`.
   (`household_invites` is the one exception: it describes a relationship
   between two users rather than data inside a scope, so it keys on
   `owner_user_id`.)
2. **`user_id` is never read from a request body or query string.** It comes
   from `requireUser()` only. The reconcile page splits one logical save across
   many independent HTTP requests, so identity is re-derived per request.
3. **`requireUser()` returns two ids and they are not interchangeable.**
   `userId` is the *data scope*; `actorId` is the *person*. In a shared
   household they differ. Every query over user data filters on `userId` —
   putting `actorId` in a `WHERE` would partition the household and hide one
   spouse's rows from the other. `actorId` is for attribution
   (`transactions.entered_by`), for `/api/tokens`, and for `/api/household`.
   Nothing else. See "Household sharing" below.
4. **Reconciliation hashing is frozen.** `generateTransactionHash`,
   `cleanBankDescription`, `parseBankAmount`, `normalizeDateOnly` and
   `disambiguateHashes` must not change. Claims, processed markers, dismissals
   and the match cache are all keyed to those hashes across ten tables — two of
   them inside JSONB (`reconciliation_uploaded_files.bank_hashes`,
   `activity_log.payload`). `app/reconcile/CLAUDE.md` documents an incident
   where a one-line change to `cleanBankDescription` orphaned ~92 claims.

   **`findMatches` and its scoring helpers are a weaker rule: stable by
   default, changeable deliberately.** Nothing is keyed to a score, so a change
   here orphans no data — it changes which rows auto-match, which silently
   rewrites the user's review queue. Never touch the scoring math, thresholds
   or `scoreCandidate` as a side effect of another change. Adding a *candidate
   filter* is the sanctioned kind of change: `rejectedPairs` (see "Rejected
   matches" below) removes pairs from consideration before scoring and alters
   no hash and no score. The same-account auto-match gate (an expense logged to
   another account is only ever *suggested*) and the 10-day merchant-memory
   window were deliberate changes of this kind — see `app/reconcile/CLAUDE.md`.
5. **`findMatches` requires `processedHashes` from the caller.** It must never
   read them itself — such a read would not be user-scoped.
6. **Deleting an account is a soft delete.** Reconciliation rows reference
   accounts by id; hard-deleting would either orphan that history or force a
   cascade that throws away months of matching. See "Accounts" below.
7. **`merchantKey` (`lib/email/merchantKey.ts`) is near-frozen.**
   `merchant_aliases` is keyed by its output, so changing what it returns makes
   every known merchant look new and re-asks everything. A change must bump
   `MERCHANT_KEY_VERSION` and ship `scripts/rekey-merchant-aliases.mjs`
   (recompute from `example_raw` + `email_events.parsed->>'merchantRaw'`) in the
   same commit. It is separate from `cleanBankDescription` and
   `generateMerchantFingerprint`, which stay frozen for reconciliation.
8. **Email ingest rules.** `/api/ingest/email` never 5xxs on a parse (a parser
   bug becomes `unparsed`; a 5xx would make the poller retry it every minute
   for a week). No route ever logs a request body or selects
   `raw_text`/`raw_html` — bank email stays in the database. Follow-up alerts
   never change the amount of a row claimed in reconciliation. See "Email
   sync" below.

### Data Flow

- All pages are client components fetching internal API routes (`/api/*`)
- `/api/transactions` — expenses, income and transfers (replaced `/api/sheets`)
- `/api/accounts` — user-defined accounts and their CSV parsing profiles;
  `PATCH` with `{ order }` sets `sort_order` (drag-to-reorder)
- `/api/accounts/[id]/csv-preview` — mapping detection + live parse preview
- `/api/budget` — monthly budgets as JSONB, one row per user
- `/api/reconciliation/*` — bank CSV matching state
- `/api/reconciliation/rejected-matches` — pairs the user disconnected; the
  negative signal that makes Disconnect stick
- `/api/reconciliation/statement-balances` — per-account statement totals that
  balances are built from; see "Balances" below
- `/api/ingest` — iOS Shortcut writes, **bearer token only**, no session
- `/api/ingest/accounts` — the account list for the Shortcut's picker, so it can
  send a real `financial_accounts.id` instead of baking UUIDs in. Also
  **bearer-only**. Scopes on `userId`
- `/api/ingest/email`, `/api/ingest/email/heartbeat` — the Gmail poller.
  **Bearer-only**, and only with a `purpose = 'email'` token. These four routes
  are the whole bearer surface: `requireUser(req, { bearerPurpose })` puts the
  purpose in `identityFromBearer`'s WHERE, so a Shortcut token can't post email
  and an email key can't log transactions through `/api/ingest`
- `/api/email-sync/*`, `/api/categorize`, `/api/merchants` — email-sync
  status, the To categorize queue and merchant rules. Session only, `userId`
- `/api/push/*`, `/api/notifications/prefs` — devices and per-account
  notification opt-ins. Session only, scope on **`actorId`** (see below)
- `/api/tokens` — ingest token management, **session only**, never bearer.
  Scopes on `actorId`, not `userId` — see "Household sharing"
- `/api/household` — who shares this Stash; invite, rename yourself, remove.
  Plus `/accept` and `/leave`. All scope on `actorId`

### Auth

Auth.js v5 (`auth.ts`) with the Neon adapter and database sessions; magic-link
email over Gmail SMTP. 90-day sessions, slid once a day.

**The email carries a typeable code as well as a link.** An installed iOS PWA
has its own cookie jar: tapping the link opens Safari, so the session lands
there and the home-screen app stays signed out, with no way to transfer it.
Entering the code on `/signin/check-email` runs the callback inside the app
instead. The code **is** the Auth.js verification token
(`generateVerificationToken`), not a parallel credential, so it inherits the
same hashed-at-rest storage, 15-minute expiry and single use as the link.
`lib/signInCode.ts` documents why it's 8 chars from a 32-char alphabet rather
than 6 digits.

`lib/signInEmail.ts` renders the email **light-first** on purpose: Gmail's dark
mode force-inverts messages that don't declare color-scheme support, and its
inversion is tuned for light designs — a dark-built email came out washed out.

`middleware.ts` only checks for a session *cookie* — Next 14.2 middleware is
Edge-only and database sessions need a DB read, so **middleware is UX, not
security**. The real check is `requireUser()` inside each Node route handler.

The root layout calls `auth()` and seeds `<SessionProvider>`, so `useSession()`
is populated on first client render and cache readers can key by user id
synchronously without an empty flash.

### Household sharing

Two people (realistically a couple) can share one Stash, each with their own
email, sign-in and iOS Shortcut token.

There is **no household table and no household id**. `user_id` keeps its
meaning as "the data scope", and that scope is simply the owner's user id.
`users.data_owner_id` points a member at the owner; `requireUser()` resolves it
into `ApiUser.userId` and nothing else in the app is aware. That is why adding
this touched no reconciliation code and no `WHERE` clause.

- **It costs nothing per request.** The Auth.js adapter does `SELECT *` and
  database sessions re-read `users` every request, so `data_owner_id` arrives on
  the session for free *and* can't go stale — an accepted invite is live on the
  next request, with no sign-out.
- **Exactly one level deep.** `/api/household/accept` refuses to attach to a
  user who is themselves a member, so no query walks a chain.
- **The Shortcut needed no changes.** `user_tokens.user_id` is the *actor*, and
  `identityFromBearer` joins through to `data_owner_id` for the scope. Each
  person's own token therefore attributes correctly by itself.
- **`/api/tokens` scopes on `actorId`.** Tokens belong to a person, not a
  household. Scoping it on `userId` would let each spouse revoke the other's
  Shortcut *and* would destroy attribution. There is a large comment saying so;
  don't "fix" it. **`/api/push/subscriptions` and `/api/notifications/prefs`
  follow the same rule** — `push_subscriptions.user_id` and
  `notification_prefs.user_id` hold the actor, because a phone belongs to a
  person. The push fan-out reaches the household through a `users` join, so
  someone removed from the household stops getting pushes with no other change.
- **Invites are email-bound.** The token alone is never sufficient — acceptance
  also requires being signed in as the invited address, so a forwarded email
  can't be redeemed by whoever receives it.
- **v1 refuses to merge.** If the invitee already has data of their own,
  acceptance fails loudly rather than orphaning it (joining would repoint every
  read at the owner's scope).
- **Removing someone deletes nothing.** `data_owner_id` goes back to NULL; the
  user row survives, so `entered_by` keeps resolving.
- **Deleting an owner would cascade the whole household.** There is no
  delete-account UI, so this is currently only a hazard to be aware of.

Attribution is `transactions.entered_by` (WHO logged it) versus `user_id`
(WHOSE data it is). It is **display-only** and must never appear in a `WHERE`.
Names surface in exactly one place: the reconcile page's `subtitle`, after the
date. The server suppresses `enteredByName` unless the scope is actually shared
*and* that person set a name, so a solo Stash is byte-identical to before and
there is no fallback to a guessed name.

UI lives in `HouseholdPanel` (chrome-free body), rendered in the **Sharing**
section of `/settings`. See "Settings" below for how that page is reached.

### Settings

`/settings` holds **sharing**, **email sync**, **notifications** and
**sign-out**, and nothing else. Email sync and Notifications were added
deliberately with email transaction sync (`docs/email-sync-plan.md` C22);
merchant rules got their own page (`/rules`). (Accounts live under Reconcile;
an older, broader `/settings` was deleted before the multi-user migration —
this is not a revival of it.)

How it is reached is load-bearing, not cosmetic:

- **A gear at the top right of New Expense.** `Sidebar` is `standalone:hidden`
  and `BottomNav` has five fixed icons with no overflow, so in the installed PWA
  a page-level control is the *only* thing that can reach this page. New Expense
  is the landing surface on a phone. Don't remove that gear without giving the
  PWA another route in.
- **The sidebar's email line on the web**, which links here. No nav item — this
  is a page you visit twice a year.

Sign-out appears both here and in the sidebar deliberately: the sidebar is the
desktop habit and doesn't exist in the PWA. Both render `SignOutButton`, so the
client-cache purge — and unsubscribing this device's push subscription — can't
be implemented in one and forgotten in the other.

### Email sync

Bank, card and Venmo alert emails land in a dedicated Gmail inbox; an Apps
Script (`apps-script/`) posts each one to `/api/ingest/email`. Plan of record
and rationale: `docs/email-sync-plan.md`. Setup: `docs/email-sync-setup.md`.

- **Store, then process.** Every email is written to `email_events` first.
  `received` is the only non-terminal status — a retry of a `received` event
  re-processes it, and the partial unique index
  `(user_id, email_event_id)` on `transactions` stops a re-process from
  double-inserting.
- **Pipeline = pure `decide()` + side-effecting `apply()`**
  (`lib/email/decide.ts`, `lib/email/apply.ts`, orchestrated by
  `lib/email/pipeline.ts`). `decide` owns every dedupe / follow-up / money-in /
  Venmo rule and is unit-tested; `apply` writes one `sql.transaction`.
- **Shadow mode** (`email_sync_settings.mode`, default) runs `decide` and stores
  the plan without writing. Each event remembers `mode_at_receipt`, so
  switching to live never backfills mail that arrived during shadow.
- **DKIM gate** (`lib/email/dkim.ts`): only Gmail's own Authentication-Results
  verdict counts, and it must be a pass for the parser's domain.
- **Account routing** is `financial_accounts.alert_source` + `alert_last4` (or
  `alert_forwarded_from` for Venmo). Never a fallback to "the only account for
  this bank"; unmatched alerts wait under Unknown account. An alert that names
  **no** account at all (Wells Fargo Bill Pay) goes to the one account ticked
  for it, `alert_unnumbered` (migration 008, parser `unnumbered`) — a stated
  rule, not a fallback. Likewise a card's "payment received" names no payer:
  the card's **Payments come from** (`payments_from_account_id`, 009) is the
  stated answer, used only when the email names nothing and that account is
  live. The API checks it's another live account in the same scope.
- **Parsers** live in `lib/email/parsers/`, registered in `lib/email/registry.ts`,
  each with fixtures under `__fixtures__/`. Bank parsers are added one at a
  time from real, scrubbed alerts (`npm run email:export`); the Venmo parser's
  v1 was written before real samples existed. Wells Fargo reads credit card
  purchases, "You just got paid early!" deposits, Bill Pay, "You made a
  payment" and online transfers; its debit card and withdrawal alerts are
  `unparsed` until real samples exist (a debit card has its own number, not
  the checking account's, so it can't simply route by last 4). It also reads
  "Your account update is here" — see "Posted-activity summaries" below.
  That rundown is how debit card purchases reach Stash today: they post to
  checking as "PURCHASE / RECURRING PAYMENT AUTHORIZED ON MM/DD <merchant> …
  CARD 1234", named by the merchant and dated by the authorization (v5,
  checked against every line of real WF checking/savings statements).
  `capitalone` reads
  Capital One **and Discover** (Capital One owns it; same sender, same
  template) — purchases, "payment received", and ignores scheduled payments.
  A hand-forwarded alert (Forward pressed by hand) is always
  `unauthenticated`: only a filter forward keeps the bank's DKIM.
- **Transfers between your own accounts** (card payments, checking → savings):
  a non-Venmo alert of kind `transfer` becomes ONE transfer row
  (`decideTransfer`, shared with Venmo legs). The other side is the account
  the email names by last 4 (this parser's accounts first); unknown → waits as
  "Which account?" in To categorize, never a guess. It links to a hand-logged
  transfer and pairs with the other bank's email within
  `transferMatchWindowDays`; two emails of the *same* type are two transfers
  unless it's the same email again. Rollback: `enableAccountTransfers`.
  A card payment seen from both ends, each naming only its own side (the
  bank's "CAPITAL ONE ONLINE PMT", the card's "payment received"), pairs in
  either order — `waitingOtherHalf`, into a credit card, one candidate only.
- **Posted-activity summaries** (Wells Fargo "Your account update is here"):
  one email listing several posted deposits/withdrawals. Everything else is
  one transaction per event, so the pipeline **splits** it into child events
  `<gmail id>#1…#n` (`lib/email/parts.ts`; full copies, own body hash, own
  status) and the parser reads only its part. The poller's id validation
  rejects `#`, so a real email can't pose as a part. Each line is
  `postedSummary`: it repeats what Bill Pay, card-payment, deposit alerts and
  hand entries usually recorded, so `alreadyRecorded` runs FIRST — same
  amount, same direction, on that account, ±`postedSummaryMatchDays` — and
  only news creates anything. Card-issuer payments and online transfers are
  transfers, rewards are a transfer from "Other" (Daniel's convention), other
  withdrawals are expenses that ask, other deposits Income.
- **"Don't record — I log these myself"** is merchant mode `skip` (010):
  `decideExpense` ignores it (`logged_by_hand`). For something logged by hand
  in pieces — a donation split across entries — which no single row matches,
  so `alreadyRecorded` can't see it.
- **Dismiss** (Needs a look) turns an `unparsed` or `unauthenticated` email
  `ignored` (`dismissed_by_person`); nothing is deleted. Google's own mail to
  the Stash inbox (`@*.google.com`) is on the ignore list.
- **Manual entries** go through `insertOrLinkTransaction` (`lib/transactions.ts`)
  in both write routes: when email sync is live, a hand-logged purchase answers
  a waiting alert row instead of doubling it — amount included, so a tipped
  total replaces the alert's pre-tip amount (Keep both restores it). Reconcile's Quick Add sends
  `source: "csv"` and is always a plain insert.
- **Tips and gas fill-ups**: an alert comes at the swipe and no card Stash reads
  emails the final amount, so a person supplies it — **Final amount, with tip**
  on `/categorize/[id]` (saved with the pick), a hand-logged total, or
  Reconcile's Correct to $X & link. Every amount change on an email row keeps
  the alert's own amount in `original_amount`: the duplicate-alert check
  matches a second copy of the alert on it. Where a person's number is one
  side, a tip may add 35% or $5 (`tipCeilingCents`); the alert-to-alert merge
  keeps the bare 35%, or two coffees at one café would merge.
- **Categories** (D2): a `needs_review` email row carries its provisional guess
  in `category`, so it counts in its budget bar, drawn as an "unconfirmed"
  share. `isUnconfirmed(row)` (`services/transactionsApi.ts`) is the one test.
  Rows with no guess appear on the dashboard's "Awaiting category" line.
  **Venmo payments are to people and are never guessed** — no default, no
  starter guess, and an answer isn't remembered as one. Only an explicit
  "Always file <name> this way" or a shortlist applies (`{ person: true }` in
  `lib/email/rules.ts`). A Venmo row's description is the note as typed.
- **Venmo** (D4): a card/bank alert whose merchant is Venmo is never an expense
  — it's a transfer card → Venmo — while the Venmo receipt is the expense.
  Money a person **sends you** on Venmo is a transfer from `"Other"` (an
  `EXTERNAL_TRANSFER_SOURCES` label) into that Venmo account, not Income —
  Daniel's convention for paybacks, replacing D1 for Venmo. Bank refunds and
  deposits still become Income. A deposit is described by its **source**
  (a merchant row, renamed under Rules → **Money in**, e.g. a paycheck as
  "Acme"), never "Deposit · …"; a refund keeps "Refund · <store>".
  `/api/merchants` flags a source as `moneyIn` when every row it names is
  income.
- **Push** (`lib/push.ts`, `worker/index.ts`): next-pwa compiles
  `worker/index.ts` to `public/worker-<hash>.js`; never hand-edit
  `public/sw.js`. There is no service worker in `next dev`, so push is tested
  on a deployed build. The unattended settle (`lib/email/unattended.ts`) runs
  from the poller heartbeat and on every queue read — there is no cron.
  A notification tap reaches its screen through the notification's own
  **`navigate` URL** (set in the worker's `showNotification`): the browser
  opens it with no worker code. That is the only thing that works on iOS when
  Stash is already running in the background — iOS never delivers
  `notificationclick` to a running app's worker (WebKit bug 268797), it just
  brings the app forward on its old page. Supported on iOS/Safari 18.5+ and
  Firefox 158+. Where it isn't (Chrome, older iOS), the tap falls through to
  `notificationclick` and `components/NotificationNavigator.tsx`, **not**
  `WindowClient.navigate()`, which iOS ignores.
  The worker tells the page three ways (a message to every window, a record in
  the `stash-nav` Cache Storage entry the page reads directly, and a pull),
  and the page re-checks for ~5s after each return to the foreground, because
  iOS can wake it before the worker has handled the tap. (Neither this nor
  the earlier one-check version could fix a backgrounded iOS app — the tap
  never reaches the worker there; only `navigate` does.) `stash-nav` holds one path, not a
  response — it is not runtime caching, and sign-out's purge clears it.

### State Management

Five React contexts (in `contexts/`):
- `ExpensesDataContext` — caches full-year transactions; refetches on `refreshKey`
- `AccountsContext` — accounts, `labelFor(id)`, `defaultAccount`, CSV profile presence
- `MonthContext` — selected month (1–12 or `"full"`)
- `RefreshContext` — `refreshKey` + `triggerRefresh()`
- `SidebarContext` — sidebar state

Pages `useMemo`-filter cached full-year data by `selectedMonth`, so month
switching costs no network calls.

**Every browser cache is keyed by user id** via `lib/clientCache.ts`. The PWA
service worker deliberately has `runtimeCaching: []` — its default config
cached `/api/*` including `/api/auth/session`, which on a shared device serves
one user's data into another's session. Sign-out purges localStorage and Cache
Storage before redirecting.

Three one-time localStorage→Neon migrations were **removed**, not scoped: they
read unscoped keys and *wrote* the result to the server, so on a shared browser
they would have pushed one user's budget or reconciliation state into another's
account.

### Accounts

Accounts are user-defined. `financial_accounts.id` (UUID) is the **immutable
internal key** written into every `account_name` column and into `match_data`
JSONB; `name` is display-only, so renaming is always safe. Render via
`labelFor(id)` — never show a raw id. `idForTx()` in the reconcile page must
keep using the raw id, not the label, or renaming detaches dismissal notes and
bulk selection.

- **`is_default`** — where an expense lands when none is given. The New Expense
  form has no account picker: the server routes accountless expenses through
  `insertTransaction` → `getDefaultAccountId`. The iOS Shortcut now picks an
  account (via `/api/ingest/accounts`), but still lands here when the user
  chooses **Default** — and when it sends an id that no longer resolves, which
  `/api/ingest` drops rather than saving as a dead reference.
- **`sort_order`** — the account order the user drags into place, and the single
  source of that order app-wide. `listAccounts` sorts on it, and every consumer
  maps straight over that result: the transfer pickers, the reconcile dropdown,
  Statement Accounts, the dashboard and net-worth balance lists (which read
  `computeAccountBalances`, seeded from `activeAccounts` in order), and the iOS
  Shortcut's picker via `/api/ingest/accounts`. **Never re-sort an account list
  at a call site** — that silently opts one screen out of the user's ordering.
  `PATCH /api/accounts` with `{ order: [...ids] }` is the only writer; it assigns
  positions from the array in one statement, so the write is atomic.
- **`deleted_at`** — deletion is soft. The row stays so past matches remain
  matched *and* correctly labeled, while the account vanishes from every picker.
  `AccountsContext.byId` therefore includes deleted accounts (for labels) while
  `accounts`/`activeAccounts` exclude them. Deleting the default promotes the
  oldest remaining account.
- Name uniqueness is a **partial unique index over live rows only** — a plain
  `UNIQUE (user_id, name)` would mean deleting "Checking" permanently reserved
  that name. Partial indexes don't appear in
  `information_schema.table_constraints`, which is why `check-schema.mjs` also
  inspects `pg_indexes`.

Managed from the **Reconcile** page via `ManageAccountsModal` (rendered in both
the empty-state and main return branches, so it's reachable before any account
exists) — *not* from `/settings`, which only covers sharing and sign-out.

### Rejected matches

Disconnecting an auto-match used to do nothing visible: it deleted the claim and
the processed marker, then finished by calling `rematchAllStoredAccounts()` —
which re-ran the matcher and auto-claimed the result. `findMatches`' first branch
pairs a bank line to a logged expense on **amount and date alone** (the
description is never consulted), so with two same-amount subscriptions on one
date it re-picked the same wrong row every time. Nothing recorded the user's
decision, so nothing could consult it.

`reconciliation_rejected_matches` is that record.

- **Keyed on the pair**, never either side alone: rejecting `A→X` must leave `A`
  free to match `Y` and `X` free to match `B`. That is the entire case that goes
  wrong.
- **Fed to `findMatches` by the caller**, as `rejectedPairKey()` strings, for the
  same reason as `processedHashes` — a read inside the matcher would not be
  user-scoped (invariant 5).
- **Applied at all four candidate paths** — exact amount+date, merchant memory,
  transfer candidates, and amount-first scoring. Filtering only the first would
  just move the wrong match one branch down.
- **Cleared by claiming that pair**, inside the `/claims` and `/transfer-claims`
  POST routes rather than at the call sites — four flows create claims and one
  would eventually be missed. Auto-matching can never reach a rejected pair, so
  anything arriving there is the user overriding an earlier disconnect.
- **The client records it before the rematch, not after**, and surfaces a failure
  rather than swallowing it: a silent no-op here is the original bug.

### Balances

**The budget is built from logged entries; balances are built from statements.**
That split is the point: a card charge and a Venmo payback can both be
dismissed, staying out of the budget, while both accounts' balances still move.
Dismissal is a reconciliation decision, never a claim that money didn't move.

`computeAccountBalances` (client, pure) picks a source per account:

- **Has uploaded statements** → anchor-or-opening + every statement row dated
  after the anchor (matched, unmatched *and* dismissed) + logged entries dated
  after the account's latest statement row that no bank line has claimed and the
  user hasn't dismissed. Entries on or before that date are presumed covered by the
  statement: counting an unreconciled one would double it.
- **No statements** → logged entries only, exactly as before. That path keys
  anchors on the UTC timestamp and is deliberately byte-identical.

The statement side comes from `lib/statementBalances.ts` via
`/api/reconciliation/statement-balances`. It must run server-side (it parses with
`reconciliationService`) and it returns per-date nets rather than one total, so
anchors are applied in the one client function and can't disagree. It skips
redundant duplicate copies with the same rule `/dedupe` uses
(`redundantDuplicateHashes`, shared), so legacy overlap doesn't double a balance
before anyone presses Remove duplicate rows.

**Direction comes from `outflow_is_positive`, which is a guess**, and a wrong
guess runs the whole balance backwards. Each summary carries a `directionCheck`:
claimed bank lines vs the `kind` of the logged entry they're linked to (expenses
should be money out). `statementDirectionLooksReversed` turns that into a warning
in the reconcile account header with a one-click flip. The flip PATCHes
`outflowIsPositive` **on its own**, not a whole `csvProfile`, because it changes
no hash and must not clear the match cache the way a remapping does.

The reconcile page refetches the summary on a debounce keyed to the state every
reconciliation handler ends by setting (matches, processed, claims, transfer
status, dismissals, accounts), rather than threading a refetch through each
handler.

### CSV formats

Column mappings live per account in `account_csv_profiles`.
`lib/csvProfileDetection.ts` guesses a mapping (header-name matching, with a
value-shape fallback) but **never auto-commits**: the user confirms it in
`components/CsvMappingModal.tsx`, which previews rows through the real parser
server-side (`reconciliationService` imports `node:crypto`, so the browser
cannot run it). Saving a changed mapping invalidates that account's match cache,
because the mapping determines each transaction's hash.

`outflow_is_positive` feeds the pre-existing `outgoingIsPositive` option on
`findMatches` — it only affects how the unmatched bucket is classified, never
the parsed sign, which would change hashes. It also decides which way each
statement row moves a balance (see "Balances").

### Key Files

| File | Notes |
|------|-------|
| `lib/db.ts` | The only `neon()` call site in the app |
| `lib/apiAuth.ts` | `requireUser()` — the single identity seam; splits `userId` (scope) from `actorId` (person) |
| `lib/household.ts` | Household membership, invite tokens, the `hasOwnData` join guard |
| `types/next-auth.d.ts` | Session/AdapterUser augmentation for `dataOwnerId` |
| `lib/accounts.ts` | Account + CSV profile loading; `toBankProfile()`, `getDefaultAccountId()` |
| `lib/transactions.ts` | Shared parse/insert for `/api/transactions` and `/api/ingest` |
| `lib/signInCode.ts`, `lib/signInEmail.ts` | Sign-in code generation and the email template |
| `app/page.tsx` | Main dashboard: charts, budget bars, account balances |
| `app/reconcile/page.tsx` | Bank CSV upload and matching UI (~6600 lines) — see its own CLAUDE.md |
| `app/new-expense/page.tsx` | Expense form + collapsed `ShortcutSetupCard` (token issue/revoke) + the gear into `/settings` |
| `app/settings/page.tsx` | Sharing + sign-out. The PWA's only route here is that gear |
| `app/guide/reconcile/page.tsx` | In-app user guide |
| `services/transactionsApi.ts` | Client transaction fetch/submit + type normalization |
| `services/reconciliationService.ts` | Match algorithm and hashing — **frozen**, see above |
| `services/accountBalancesService.ts` | Balances from accounts + anchors + statements (or logged entries where there are none) |
| `lib/statementBalances.ts` | Server-side statement summaries for balances; shared duplicate rule with `/dedupe` |
| `docs/neon-setup.sql` | The schema. Single source of truth |
| `docs/migrations/` | Ordered ALTERs for databases created from an older schema |
| `app/api/reconciliation/rejected-matches/route.ts` | Disconnected pairs — see "Rejected matches" |
| `docs/reconciliation-guide.md` | User-facing guide (in-app at `/guide/reconcile`) |
| `docs/ios-shortcut-setup.md` | One-time authoring of the shareable Shortcut |
| `docs/email-sync-plan.md` | Email transaction sync — plan of record and rationale (conflicts C1–C27, decisions D1–D6) |
| `docs/email-sync-setup.md`, `apps-script/` | Email sync setup checklist and the Gmail poller (in-app at `/guide/email-sync`) |
| `lib/email/pipeline.ts` | One stored email through route → DKIM → parse → account → decide → apply → notify |
| `lib/email/decide.ts` | PURE: every dedupe, follow-up, money-in (D1) and Venmo (D4) rule. Unit-tested |
| `lib/email/apply.ts` | A plan → one `sql.transaction` |
| `lib/email/merchantKey.ts` | Near-frozen merchant normalizer (invariant 7) |
| `lib/email/parsers/`, `lib/email/registry.ts` | Per-sender parsers + fixtures; `_template.ts` for new banks |
| `lib/email/csvSuggest.ts` | Reconcile's "Correct to $X & link" — outside `findMatches` |
| `lib/push.ts`, `worker/index.ts` | Web push fan-out and the service-worker push handlers |
| `app/categorize/`, `components/CategorizeQueue.tsx` | To categorize — the queue is self-contained so it can move into Reconcile (D5) |
| `app/rules/page.tsx` | Merchant rules |

`HANDOFF.md` describes the **pre-migration single-user app** and is retained
only as history — it carries a staleness banner. Do not treat it as current.

### Budget Logic

- Monthly budgets stored as `Record<monthNumber, Record<categoryName, amount>>`
- A month with no budget inherits (carry-forward) from the previous month
- Full Year view aggregates all 12 months
- Category names normalize through `budgetCategoryMigration.ts`

Expense **categories** are still hardcoded in `lib/constants.ts` — budget
storage, the migration helper and `CATEGORY_COLORS` are all keyed to those 16
strings. Email-sync merchant rules store the same names as text. User-defined categories would be a coherent follow-up.

### Transactions

`/api/transactions` returns rows already aliased to the camelCase field names
`services/transactionsApi.ts` normalizes (`rowId`, `expenseType`,
`transferRowId`, …), so its alias table passes them through untouched. Keeping
that shape is what let the Sheets→Neon move avoid touching nine consumers.

Three deliberate choices in the GET query:
- `timestamp` is UTC-ISO with a trailing `Z`, matching what Apps Script emitted;
  a local-looking string would be parsed as local and read back as UTC.
- `month` is derived in the user's timezone (`users.timezone`) via `FMMM` → `"3"`,
  not `"03"`. Deriving in UTC would push evening transactions into the next month.
- Ordering is `created_at`, not `occurred_at` — Sheets returned append order and
  some client code assumes newest-last.

`date` used to be undefined on every row and the matcher prefers
`date ?? timestamp`, so emitting a real local date **changes auto-match
scoring**. `TRANSACTIONS_EMIT_DATE=false` reverts to the old behavior.

### Neon DB Access Pattern

Raw SQL via `@neondatabase/serverless`, no ORM, one cached client from
`lib/db.ts`. Bulk inserts use per-row transactions chunked at 15 to stay within
the HTTP driver's limits (`CSV_SAVE_CHUNK_SIZE`, `NEON_SAVE_CHUNK_SIZE`).

`reconciliation_csv_rows.seq` is load-bearing: `disambiguateHashes` appends
`-2`/`-3` by array order, and `created_at` alone is ambiguous because it is
transaction time (a whole chunk shares one value). Both read sites order by
`(created_at, seq)`.

### Styling

Tailwind CSS, custom dark theme — charcoal (`#1A1A1A`) background, green
(`#50C878`) accent. Alternating tile rows use `#2C2C2C`. Tokens in
`tailwind.config.ts`.
