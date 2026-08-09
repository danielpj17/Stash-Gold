# Plan — Household sharing (two people, one Stash)

> Status: **implemented 2026-08-08**, except where noted. Kept as the rationale
> record — `/CLAUDE.md` has the short version of how it works now.
>
> Not done, deliberately: merging an invitee's existing data (v1 refuses), and a
> guard against deleting an owner who still has a member (there is no
> delete-account UI to guard).

## Goal

Let a second person (realistically a spouse) sign in with **their own email** and
see and edit the **same** budget, accounts, transactions and reconciliation
state as the first person. Each keeps their own iOS Shortcut token, and the
reconcile page shows **who entered each logged transaction**.

Constraints that shape every decision below:

- **Small and invisible.** A solo user must never see a new nav item, a new
  route, or a name label. The feature should cost one collapsed card.
- **The frozen reconciliation surface stays frozen.** No hashing function, no
  `findMatches` scoring, no `user_id` filter changes.
- **v1 assumes the invitee has never used Stash.** Merging two existing
  datasets is explicitly out of scope.

---

## The model: the household *is* the owner's `user_id`

Every user-data table already carries `user_id` and filters on it. The naive
approach — adding `household_id` to eighteen tables and rewriting every query —
would touch the frozen reconciliation routes and put invariant #1 at risk on
every single one.

Instead, keep `user_id` exactly as it is and **redefine what it means**: it is
the household's data scope, which happens to be the owner's user id. Then split
identity in two at the one place identity is derived.

```
signed-in user  ──►  requireUser()  ──►  userId  (data scope — the owner's id)
                                    └──►  actorId (who is actually acting)
```

`userId` feeds every existing query, unchanged. `actorId` is used in exactly
three places: minting/reading ingest tokens, stamping `transactions.entered_by`,
and the household-management route itself.

### Why this fits this codebase specifically

1. [`requireUser()`](../lib/apiAuth.ts#L58-L78) is already the single identity
   seam, documented as such and enforced by the "never read `user_id` from a
   request body" invariant. Adding a second field there is the whole change.
2. [`neon-setup.sql:28-30`](./neon-setup.sql#L28-L30) already notes that the
   Auth.js adapter does `SELECT *` on `users`, so any extra column is available
   in the session callback **for free, with no extra query**. `data_owner_id`
   rides along.
3. Database sessions mean `users` is re-read on every request, so a freshly
   accepted invite takes effect on the next request — no sign-out, no cache
   invalidation, no staleness window.
4. `userIdFromBearer` already does one `UPDATE … RETURNING`; adding a join to
   `users` gets both ids in the same round trip. **The iOS Shortcut needs no
   changes at all** — each spouse's own token identifies them naturally.

---

## Schema changes

New migration `docs/migrations/002-household-sharing.sql`, mirrored into
`docs/neon-setup.sql` (the source of truth).

```sql
-- 1. Household membership.
--    NULL = you own your own data. Set = your data scope is that user's.
--    Deliberately NOT a cascade delete: see "Owner deletion" under Risks.
ALTER TABLE users
  ADD COLUMN data_owner_id UUID REFERENCES users(id);

CREATE INDEX idx_users_data_owner ON users(data_owner_id)
  WHERE data_owner_id IS NOT NULL;

-- 2. Attribution. NULL = entered before sharing existed (or by a since-deleted
--    user). Never used for filtering — display only.
ALTER TABLE transactions
  ADD COLUMN entered_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- 3. Invites. One pending invite per (owner, email).
--    `email` is stored lowercased; acceptance compares it to the session email.
CREATE TABLE household_invites (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,-- sha256, same reasoning as user_tokens
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  accepted_at    TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_household_invites_pending
  ON household_invites (owner_user_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```

Notes on shape:

- `household_invites` is **not** in `check-schema.mjs`'s `USER_SCOPED` list —
  its scoping column is `owner_user_id`, not `user_id`. It needs its own entry
  so the checker doesn't flag it. Same for the two partial indexes, which is
  why the checker already inspects `pg_indexes`.
- Backfill in the same migration:
  `UPDATE transactions SET entered_by = user_id WHERE entered_by IS NULL;`
  Every existing row was in fact entered by the owner, so this is accurate, and
  it means the reconcile page never renders a blank name once sharing is on.
  Decided: **yes, backfill.**

---

## Code changes, file by file

### 1. `lib/apiAuth.ts` — the seam

```ts
export type ApiUser = {
  sql: Sql;
  /** The DATA scope. Every query filters on this. The household owner's id. */
  userId: string;
  /**
   * WHO is acting. Use ONLY for attribution and for per-person resources
   * (ingest tokens). Never put this in a WHERE clause over user data — that
   * would partition a shared household and hide one spouse's rows from the
   * other.
   */
  actorId: string;
  via: "session" | "token";
};
```

- Session path: read `data_owner_id` off the session user (populated by the
  callback below). `userId = dataOwnerId ?? user.id`, `actorId = user.id`.
- Bearer path: extend the existing statement so one round trip returns both.

```sql
UPDATE user_tokens t
   SET last_used_at = now()
  FROM users u
 WHERE t.token_hash = $1
   AND t.revoked_at IS NULL
   AND u.id = t.user_id
RETURNING t.user_id AS actor_id,
          COALESCE(u.data_owner_id, u.id) AS owner_id
```

### 2. `auth.ts` — session callback

```ts
session({ session, user }) {
  if (session.user) {
    session.user.id = user.id;
    session.user.dataOwnerId = (user as { data_owner_id?: string | null }).data_owner_id ?? null;
  }
  return session;
}
```

There is currently **no** `types/next-auth.d.ts` in the repo — `session.user.id`
typechecks off the library's own optional `id`. Adding `dataOwnerId` requires a
new declaration file augmenting both `next-auth`'s `Session` and
`@auth/core/adapters`' `AdapterUser`.

### 3. `lib/transactions.ts` — attribution

- `insertTransaction(sql, userId, input)` gains an `actorId` parameter and
  writes `entered_by`.
- `EXPENSE_SELECT_FIELDS` and `TRANSFER_SELECT_FIELDS` gain one aliased column.
  Because the alias table in `services/transactionsApi.ts` passes camelCase
  names through untouched, this is genuinely additive:

  ```sql
  eb.name AS "enteredByName"
  ```

  via `LEFT JOIN users eb ON eb.id = t.entered_by`. **Left** join, and the
  column must tolerate NULL — some rows will always be unattributed.

  Note: the existing `JOIN users u ON u.id = t.user_id` stays as-is and now
  resolves to the **owner's** timezone. That is the behavior we want (one shared
  month boundary for the household), but it is a real semantic, not an accident.

### 4. `app/api/tokens/route.ts` — the one route that must invert

This is the most important correctness detail in the plan. All three handlers
currently use `userId` for `user_tokens.user_id`. They **must** switch to
`actorId`. If tokens stay household-scoped:

- both spouses see and can revoke each other's tokens, and
- `userIdFromBearer` can no longer tell who sent an ingest request, which
  destroys the entire attribution mechanism.

Worth a comment in the file saying exactly that, because "use `userId`" is the
correct default everywhere else and a future edit will want to "fix" it back.

### 5. `app/api/transactions/route.ts` and `app/api/ingest/route.ts`

Pass `actorId` through to `insertTransaction`. No other change — the GET query's
`WHERE user_id = ` stays on the household scope, so both spouses see one
combined list.

### 6. New: `app/api/household/route.ts`

- `GET` → `{ role: "owner" | "member" | "solo", members: [{ id, name, email }], pendingInvite }`
- `POST { email }` → owner-only; creates an invite, sends the email
- `PATCH { name }` → sets **your own** `users.name`. Writes to `actorId`, never
  to another member. This is the "each person sets their own name" path.
- `DELETE { memberId | inviteId }` → owner-only; revokes an invite or removes a
  member (`UPDATE users SET data_owner_id = NULL`)
- `POST /api/household/leave` → member-only, self-service exit

All authorize on **`actorId`**, and all check `actorId === userId` to mean
"I am the owner."

### 7. New: `lib/inviteEmail.ts`

Same structure as [`lib/signInEmail.ts`](../lib/signInEmail.ts), including the
**light-first** rendering — Gmail force-inverts messages that don't declare
color-scheme support, and its inversion is tuned for light designs. Do not
build this one dark.

### 8. New: `app/invite/[token]/page.tsx` + accept route

Flow:

1. Recipient opens the link. Not signed in → bounce to `/signin` with the
   invited email pre-filled and a `callbackUrl` back to the invite.
2. Signed in → accept route validates, in this order:
   - invite exists, not accepted, not revoked, not expired
   - `session.user.email` (lowercased) **equals** `invite.email` — this is what
     makes "only that email is allowed" true
   - the invitee's own `data_owner_id IS NULL` (not already in a household)
   - the **owner's** `data_owner_id IS NULL` — no chains, one level only
   - the invitee has **no data of their own** (v1 guard, see below)
3. `UPDATE users SET data_owner_id = <owner>` and stamp `accepted_at`, in one
   `sql.transaction`.
4. The accept page then asks, once, **"What should we call you?"** and `PATCH`es
   `/api/household`. Skippable — the fallback below covers it.

The "no data of their own" guard is a single existence check across
`transactions`, `financial_accounts` and `budget_store`. If it trips, show
"This account already has its own Stash data" and stop, rather than silently
orphaning it. We are assuming this never fires; it exists so that the failure
mode is a clear message instead of data loss.

---

## Attribution display

Per your call, names appear in **one place only**: the reconcile page, next to
the date on user-inputted entries. **Both names show, always** — every row is
labeled once a second person exists, so the two of you see identical screens and
a blank never has to mean "me".

### An unset name shows nothing

"Both names always" plus "each person sets their own name" leaves a gap:
`users.name` is NULL for everyone today, and a member can skip the prompt on the
accept page. The rule is to **stay silent rather than guess**:

- Household of one → no name on any row, ever. A solo user cannot tell this
  feature exists.
- Household of two, name set → name renders after the date.
- Household of two, name unset → that row's subtitle is unchanged.

No fallback to the email local-part, no initials, no "Unknown". A missing name
degrades to exactly the current behavior, which is the safe direction: the
subtitle is a display string, and a wrong-looking name is worse than no name.

The Household card offers a **"Your name"** field, for owner and member alike.
Both people set their own; nobody names anybody else.

That resolves to a two-line change, because the reconcile page already builds a
self-contained display string. In
[`userInputtedEntries`](../app/reconcile/page.tsx#L1592-L1645):

```ts
// expenses — line 1606
subtitle: `${fmtMoney(...)} • ${category} • ${fmtDate(dateValue)}${who}`

// transfers — line 1637
subtitle: `${fmtMoney(...)} • Transfer • ${fmtDate(dateValue)}${who}`
```

where `who` is `""` unless the household has 2+ members. `UserInputtedEntry`
gains an optional `enteredByName?: string` for searchability, alongside the
existing `accountLabel` which follows exactly that pattern (searchable, not
displayed).

Because it flows through `subtitle`, it lands in both review lists and both
matched lists automatically, and it is **invisible for a solo user** without a
single conditional in the JSX.

`SheetRow` / `TransferRow` in `services/transactionsApi.ts` each gain an
optional `enteredByName?: string`, read through the existing `getRawValue`
alias mechanism. Nothing else consumes it.

---

## UI placement

> **Superseded.** Shipped as described below, then moved: the panel now lives in
> a **Sharing** section on `/settings`, reached by a gear at the top right of New
> Expense (and from the sidebar's email line on the web). `HouseholdCard` and
> `HouseholdModal` were deleted; `HouseholdPanel` moved untouched, which is what
> keeping it chrome-free bought. The PWA reasoning below is unchanged and is
> exactly why the gear had to go on New Expense.

**Two entry points, one component** (`components/HouseholdCard.tsx`):

**In the installed PWA** — a collapsed card on
[`/new-expense`](../app/new-expense/page.tsx#L143), directly below
`ShortcutSetupCard`. This is load-bearing, not a preference:
[`Sidebar.tsx:49`](../components/Sidebar.tsx#L49) is `standalone:hidden` and
[`BottomNav`](../components/BottomNav.tsx#L13-L19) has five fixed icons with no
overflow, so **in the installed app the sidebar footer is unreachable**. New
Expense is the only surface reachable from both web and PWA, and it is already
where account plumbing lives (each spouse mints their own token there anyway,
right above).

Collapsed header copy:
- solo → **"Share with someone"** / _"Give your spouse their own sign-in to the same budget."_
- shared → **"Shared with Sarah"** / _"You and Sarah both use this Stash."_

Expanded, the card holds: your own name field (when unset), the invite form or
the current member with a remove/leave action, and nothing else.

**On the web** — make the email line at
[`Sidebar.tsx:121-125`](../components/Sidebar.tsx#L121-L125) a button that opens
the same content in a modal, following the `ManageAccountsModal` pattern. No new
nav item, no new route, no `/settings`.

---

## Security review checklist

Run through this before merging — it is the part that can go quietly wrong.

- [ ] `grep` every `WHERE user_id` / `user_id =` in `app/api/**` and confirm
      none of them received `actorId`. Only `app/api/tokens/route.ts` and
      `app/api/household/**` use `actorId`, and neither touches user data.
- [ ] `actorId` never reaches a `DELETE`.
- [ ] `entered_by` is written from `actorId` and read **only** for display —
      never in a `WHERE`.
- [ ] `PATCH /api/household { name }` writes to `actorId` and cannot be aimed at
      another member — one person renaming the other is the whole risk here.
- [ ] Invite acceptance compares session email to invite email, case-folded,
      server-side. The token alone must not be sufficient.
- [ ] The invite token is compared by hash, and the raw token appears only in
      the email.
- [ ] No chains: acceptance rejects an owner who is themselves a member.
- [ ] `middleware.ts` is untouched — it is still UX, not security.
- [ ] `lib/clientCache.ts` still keys on the **signed-in** user id, not the
      owner id. Two spouses on one browser then get separate caches of the same
      shared data: slightly redundant, but a shared cache key on a shared device
      is the exact bug the `runtimeCaching: []` note in `/CLAUDE.md` exists to
      prevent.
- [ ] Sign-out purge behavior unchanged.

---

## Risks and edge cases

**Owner deletion cascades the household.** Every table is
`REFERENCES users(id) ON DELETE CASCADE`, so deleting the owner destroys the
shared data while the member's account survives pointing at nothing. There is no
delete-account UI today, so this is a documentation item in `neon-setup.sql`
plus a `data_owner_id` FK that is deliberately *not* `ON DELETE CASCADE` — but if
account deletion is ever built, it must refuse while members are attached.

**Concurrent reconciling.** Both spouses share one reconciliation state, which
is the point, but there is no locking anywhere in the app. Two people uploading
CSVs for the same account simultaneously could interleave badly. For two people
who live together this is a near-zero risk and I would not build locking for it —
but it is a genuine new failure mode that does not exist today.

**No realtime.** A member's cached full-year data does not refresh when the
other adds a transaction. This is already true across devices for one user, so
it is not a regression, but it will feel more noticeable with two people.

**The member's timezone is ignored.** Month derivation uses the owner's
`users.timezone`. Correct for a couple; would be wrong for coworkers in
different timezones.

**Reconciliation is untouched.** Hashes are keyed to `user_id`, which is now the
household, so shared state falls out for free. No frozen function changes.

---

## Phasing

| Phase | Contents | Verifiable by |
|---|---|---|
| 1 | Migration + `requireUser` split + tokens route inversion | Everything still works solo; `check-schema.mjs` passes; a token still ingests |
| 2 | `entered_by` write + read + reconcile subtitle | Own entries show your name once a second member exists; unset names fall back to the email local-part, not blank |
| 3 | Invite table, email, accept page (incl. the name prompt) | End-to-end invite on a scratch email |
| 4 | `HouseholdCard` (incl. "Your name") + both mount points | Manual pass in browser and installed PWA |
| 5 | Docs: `/CLAUDE.md` invariants section, `neon-setup.sql` comments | — |

Roughly 10 files, 3 of them new. Phase 1 is the risky one and is independently
shippable — after it, the app behaves identically for a solo user and nothing
else in the plan can corrupt data.
