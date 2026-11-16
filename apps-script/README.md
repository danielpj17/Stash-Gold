# Stash Gmail poller (Apps Script)

Forwards each alert email in the **Stash Gmail inbox** to Stash. It only moves
email — every bit of parsing happens in Stash. Full walkthrough, including bank
setup and forwarding filters: `docs/email-sync-setup.md` (in the app at
`/guide/email-sync`). Design notes: `docs/email-sync-plan.md` §5.1.

## Install (once, ~10 minutes)

1. Sign in to the **Stash Gmail account** (not your personal one) and open
   <https://script.google.com> → **New project**. Name it `Stash poller`.
2. **Project Settings** (gear) → tick **Show "appsscript.json" manifest file in
   editor**.
3. Replace `appsscript.json` with this folder's `appsscript.json`, and
   `Code.gs` with `poller.gs` (rename it or paste the contents — the file name
   doesn't matter).
4. **Project Settings → Script Properties → Add script property**:
   - `STASH_URL` — your deployed Stash, e.g. `https://your-stash.vercel.app`
     (https, no trailing slash; `localhost` can't be reached from Google).
   - `STASH_TOKEN` — from Stash → **Settings → Email sync → Create email-sync
     key**. It's shown once.
5. Select `setup` in the function dropdown → **Run**. Approve the permissions
   (Gmail read/label, external requests, triggers). Google may warn that the
   app is unverified: **Advanced → Go to Stash poller** — it's your own script.
6. Back in Stash, Settings → Email sync should show a check-in within a minute.

## What it does

| Trigger | Every | Does |
|---|---|---|
| `poll` | 1 min | Lists **messages** (not threads) without a `stash-processed` / `stash-rejected` label from the last 7 days, oldest first, ≤25 per run, ≤45 s, and POSTs each to `/api/ingest/email`. |
| `heartbeat` | 15 min | POSTs `/api/ingest/email/heartbeat`, which Settings uses to show "last check-in" and which settles unanswered items. |

Responses: **2xx** → label `stash-processed`. **401/403** → stop (bad or revoked
key). **429/5xx/network** → stop, label nothing, retry next minute. **Other
4xx** → label `stash-rejected` and continue, so one bad message can't block the
queue.

## Why it's built this way

- **Per-message labels via the Advanced Gmail service.** `GmailApp` labels
  whole threads, and banks send identically-subjected alerts that Gmail threads
  together — labelling the thread after the first alert would silently skip
  the rest.
- **`LockService`** so a slow run never overlaps the next minute's.
- **`newer_than:7d`** survives a long-weekend outage; Stash dedupes by Gmail
  message id, so re-sending is free.
- **The first `Authentication-Results` header** is sent, because that's the one
  Gmail itself added on arrival; Stash's DKIM gate trusts only that one.

## Repairing it

- **Settings shows the check-in amber** → open the script and run `setup` again
  (it's idempotent). If Google asks you to re-authorize — e.g. after a password
  change on the Stash account — approve it.
- **Revoked or rotated the key** → put the new one in `STASH_TOKEN`. Nothing was
  labelled while it was rejected, so the backlog catches up on the next run.
- **Quota:** consumer accounts get 90 min/day of trigger time. If the
  **Executions** page shows more than ~60 min/day, change `poll` to every 5
  minutes in `setup()` and run it again.

## Rollback

Delete the triggers (**Triggers** page, or run a function that calls
`ScriptApp.getProjectTriggers().forEach(ScriptApp.deleteTrigger)`) and revoke
the key in Stash. No Stash data is touched.
