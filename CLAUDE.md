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
present but there is no ESLint config checked in, so `next build` is the real
typecheck gate.

## Environment Setup

Copy `.env.example` to `.env.local` and populate `DATABASE_URL`, `AUTH_SECRET`,
`AUTH_URL`, and the Gmail SMTP vars.

**Run `docs/neon-setup.sql` once against a fresh Neon database before first
sign-in** — sessions live in that database, so nothing works until it exists.
That file is the single source of truth for the schema; API routes no longer
create tables at request time.

## Architecture

**Stash** is a multi-user Next.js 14 personal finance dashboard. All data lives
in **Neon Postgres** — transactions, budgets, accounts, reconciliation state,
and Auth.js sessions. There are no external data systems. (Transactions used to
live in Google Sheets; that is fully retired.)

### Non-negotiable invariants

These are the rules that keep the app correct. Break one and the damage is
silent and expensive.

1. **Every table holding user data carries `user_id`, prepended to its primary
   key and to every UNIQUE constraint.** Every query filters on it — including
   inside `NOT EXISTS` subqueries, and especially every `DELETE`.
2. **`user_id` is never read from a request body or query string.** It comes
   from `requireUser()` only. The reconcile page splits one logical save across
   many independent HTTP requests, so identity is re-derived per request.
3. **Reconciliation hashing is frozen.** `generateTransactionHash`,
   `cleanBankDescription`, `parseBankAmount`, `normalizeDateOnly`,
   `disambiguateHashes`, `findMatches` and its scoring helpers must not change.
   Claims, processed markers, dismissals and the match cache are all keyed to
   those hashes across nine tables — two of them inside JSONB
   (`reconciliation_uploaded_files.bank_hashes`, `activity_log.payload`).
   `app/reconcile/CLAUDE.md` documents an incident where a one-line change to
   `cleanBankDescription` orphaned ~92 claims.
4. **`findMatches` requires `processedHashes` from the caller.** It must never
   read them itself — such a read would not be user-scoped.

### Data Flow

- All pages are client components fetching internal API routes (`/api/*`)
- `/api/transactions` — expenses, income and transfers (replaced `/api/sheets`)
- `/api/accounts` — user-defined accounts and their CSV parsing profiles
- `/api/budget` — monthly budgets as JSONB, one row per user
- `/api/reconciliation/*` — bank CSV matching state
- `/api/ingest` — iOS Shortcut writes, **bearer token only**, no session
- `/api/tokens` — ingest token management, **session only**, never bearer

### Auth

Auth.js v5 (`auth.ts`) with the Neon adapter and database sessions; magic-link
email over Gmail SMTP. 90-day sessions, slid once a day.

`middleware.ts` only checks for a session *cookie* — Next 14.2 middleware is
Edge-only and database sessions need a DB read, so **middleware is UX, not
security**. The real check is `requireUser()` inside each Node route handler.

The root layout calls `auth()` and seeds `<SessionProvider>`, so `useSession()`
is populated on first client render and cache readers can key by user id
synchronously.

### State Management

Five React contexts (in `contexts/`):
- `ExpensesDataContext` — caches full-year transactions; refetches on `refreshKey`
- `AccountsContext` — the user's accounts, `labelFor(id)`, CSV profile presence
- `MonthContext` — selected month (1–12 or `"full"`)
- `RefreshContext` — `refreshKey` + `triggerRefresh()`
- `SidebarContext` — sidebar state

Pages `useMemo`-filter cached full-year data by `selectedMonth`, so month
switching costs no network calls.

**Every browser cache is keyed by user id** via `lib/clientCache.ts`. The PWA
service worker deliberately has `runtimeCaching: []` — its default config
cached `/api/*` including `/api/auth/session`, which on a shared device serves
one user's data into another's session.

### Accounts and CSV formats

Accounts are user-defined. `financial_accounts.id` (UUID) is the **immutable
internal key** written into every `account_name` column and into `match_data`
JSONB; `name` is display-only, so renaming is always safe. Render via
`labelFor(id)` — never show a raw id.

CSV column mappings live per account in `account_csv_profiles`.
`lib/csvProfileDetection.ts` guesses a mapping but **never auto-commits**: the
user confirms it in `components/CsvMappingModal.tsx`, which previews rows
through the real parser server-side (`reconciliationService` imports
`node:crypto`, so the browser cannot run it).

### Key Files

| File | Notes |
|------|-------|
| `lib/db.ts` | The only `neon()` call site in the app |
| `lib/apiAuth.ts` | `requireUser()` — the single identity seam |
| `lib/accounts.ts` | Account + CSV profile loading; `toBankProfile()` |
| `lib/transactions.ts` | Shared parse/insert for `/api/transactions` and `/api/ingest` |
| `app/page.tsx` | Main dashboard: charts, budget bars, account balances |
| `app/reconcile/page.tsx` | Bank CSV upload and matching UI (~6400 lines) — see its own CLAUDE.md |
| `app/net-worth/page.tsx` | Assets/liabilities + net worth trends |
| `services/transactionsApi.ts` | Client transaction fetch/submit + type normalization |
| `services/reconciliationService.ts` | Match algorithm and hashing — **frozen**, see above |
| `services/accountBalancesService.ts` | Balances from accounts + transactions + transfers + anchors |
| `docs/neon-setup.sql` | The schema. Single source of truth |
| `docs/reconciliation-guide.md` | User-facing guide (in-app at `/guide/reconcile`) |

### Budget Logic

- Monthly budgets stored as `Record<monthNumber, Record<categoryName, amount>>`
- A month with no budget inherits (carry-forward) from the previous month
- Full Year view aggregates all 12 months
- Category names normalize through `budgetCategoryMigration.ts`

Expense **categories** are still hardcoded in `lib/constants.ts` — budget
storage, the migration helper and `CATEGORY_COLORS` are all keyed to those 15
strings. User-defined categories would be a coherent follow-up.

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
