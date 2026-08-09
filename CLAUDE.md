# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server at http://localhost:3000
npm run build    # Production build (also runs typecheck)
npm run start    # Run production build
node scripts/check-schema.mjs   # Verify the DB matches docs/neon-setup.sql
```

No test suite — feature verification is manual via browser. `npm run lint` is
present but there is **no ESLint config checked in**, so `next lint` just
prompts for setup; `next build` is the real typecheck gate.

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
   `cleanBankDescription`, `parseBankAmount`, `normalizeDateOnly`,
   `disambiguateHashes`, `findMatches` and its scoring helpers must not change.
   Claims, processed markers, dismissals and the match cache are all keyed to
   those hashes across nine tables — two of them inside JSONB
   (`reconciliation_uploaded_files.bank_hashes`, `activity_log.payload`).
   `app/reconcile/CLAUDE.md` documents an incident where a one-line change to
   `cleanBankDescription` orphaned ~92 claims.
5. **`findMatches` requires `processedHashes` from the caller.** It must never
   read them itself — such a read would not be user-scoped.
6. **Deleting an account is a soft delete.** Reconciliation rows reference
   accounts by id; hard-deleting would either orphan that history or force a
   cascade that throws away months of matching. See "Accounts" below.

### Data Flow

- All pages are client components fetching internal API routes (`/api/*`)
- `/api/transactions` — expenses, income and transfers (replaced `/api/sheets`)
- `/api/accounts` — user-defined accounts and their CSV parsing profiles
- `/api/accounts/[id]/csv-preview` — mapping detection + live parse preview
- `/api/budget` — monthly budgets as JSONB, one row per user
- `/api/reconciliation/*` — bank CSV matching state
- `/api/ingest` — iOS Shortcut writes, **bearer token only**, no session
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
- **`/api/tokens` is the one route that scopes on `actorId`.** Tokens belong to
  a person, not a household. Scoping it on `userId` would let each spouse revoke
  the other's Shortcut *and* would destroy attribution. There is a large comment
  saying so; don't "fix" it.
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

UI lives in `HouseholdPanel` (chrome-free body), mounted twice: a collapsed
`HouseholdCard` under New Expense, and `HouseholdModal` off the sidebar's email
line. New Expense is not a preference — `Sidebar` is `standalone:hidden` and
`BottomNav` is full, so it is the only surface reachable from the installed PWA.

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
  `insertTransaction` → `getDefaultAccountId`. This is also what makes the iOS
  Shortcut work, since it can't reasonably send a UUID.
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
exists). There is no `/settings` route.

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
the parsed sign, which would change hashes.

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
| `app/new-expense/page.tsx` | Expense form + collapsed `ShortcutSetupCard` (token issue/revoke) |
| `app/guide/reconcile/page.tsx` | In-app user guide |
| `services/transactionsApi.ts` | Client transaction fetch/submit + type normalization |
| `services/reconciliationService.ts` | Match algorithm and hashing — **frozen**, see above |
| `services/accountBalancesService.ts` | Balances from accounts + transactions + transfers + anchors |
| `docs/neon-setup.sql` | The schema. Single source of truth |
| `docs/migrations/` | Ordered ALTERs for databases created from an older schema |
| `docs/reconciliation-guide.md` | User-facing guide (in-app at `/guide/reconcile`) |
| `docs/ios-shortcut-setup.md` | One-time authoring of the shareable Shortcut |

`HANDOFF.md` describes the **pre-migration single-user app** and is retained
only as history — it carries a staleness banner. Do not treat it as current.

### Budget Logic

- Monthly budgets stored as `Record<monthNumber, Record<categoryName, amount>>`
- A month with no budget inherits (carry-forward) from the previous month
- Full Year view aggregates all 12 months
- Category names normalize through `budgetCategoryMigration.ts`

Expense **categories** are still hardcoded in `lib/constants.ts` — budget
storage, the migration helper and `CATEGORY_COLORS` are all keyed to those 15
strings. User-defined categories would be a coherent follow-up.

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
