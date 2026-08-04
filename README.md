# Stash

A responsive financial dashboard built with **Next.js 14**, **Tailwind CSS**, and **Lucide React** icons. Charcoal background with light blue accents.

## Features

- **Sidebar navigation**: New Expense, Expenses (default), Budget, Net Worth
- **Month selector**: Dropdown in the top right (January 2026 – December 2026, plus Full Year 2026)
- **Responsive layout**: Collapsible sidebar on desktop; drawer overlay on mobile
- **Theme**: Charcoal (`#1E1E1E`) with light blue accent (`#7BC0FF`)
- **Multi-user**: sign in with an emailed magic link; every account is fully isolated.
- **User-defined accounts**: name your own checking / savings / credit cards.
- **Any bank's CSV**: column mappings are detected and confirmed per account.
- **iOS Shortcut**: log an expense from your phone with no login, via a personal token.

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Required setup

1. **Create a Neon Postgres database** and put its connection string in
   `DATABASE_URL`.
2. **Run `docs/neon-setup.sql` once** in Neon's SQL editor. Sessions live in
   this database, so sign-in fails until the tables exist.
3. **Generate an auth secret**: `npx auth secret` → `AUTH_SECRET`. Set
   `AUTH_URL` to your origin (`http://localhost:3000` locally).
4. **Set up magic-link email.** Gmail SMTP works and is free: turn on 2-Step
   Verification, create an **App Password** (a normal password will not work),
   and fill in the `EMAIL_*` vars.

Then sign in with your email address — the first sign-in creates your account.
Add your accounts under **Settings → Accounts** before uploading statements.

Verify the database anytime with `node scripts/check-schema.mjs`.

## Reconciling

Matching bank statements against what you logged is documented in
[docs/reconciliation-guide.md](docs/reconciliation-guide.md), and in the app at
`/guide/reconcile`.

## Account balances

Balances are computed entirely from your own data: an opening balance per account, plus every
expense and transfer, optionally rebased on a confirmed statement balance (an "anchor") set
from the Reconcile page. There is no live brokerage connection — investment accounts are
tracked as manual assets or as ordinary accounts with anchors.

## Scripts

- `npm run dev` – development server
- `npm run build` – production build
- `npm run start` – run production server
- `npm run lint` – run ESLint
