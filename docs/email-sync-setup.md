# Email sync — setup checklist

In the app: **/guide/email-sync**. Design and rationale: `docs/email-sync-plan.md`.

Bank, card and Venmo alert emails land in one dedicated Gmail inbox. A small
Apps Script forwards each one to Stash, which turns it into a transaction,
files it by your merchant rules, and asks when it can't.

## 1. A dedicated Gmail account

- Create a new Gmail account just for Stash (e.g. `yourname.stash@gmail.com`).
- Give it a **unique password** and turn on **2-Step Verification**. It will
  hold every purchase both of you make.

## 2. Get alerts into that inbox

For each bank, card and Venmo account, either:

- **Send alerts straight to the Stash address**, if the bank lets you add an
  alert email; or
- **Forward from your own inbox** with a Gmail filter: in *your* Gmail →
  Settings → **Forwarding and POP/IMAP** → *Add a forwarding address* (the Stash
  address). Gmail emails the Stash inbox a confirmation code — Stash ignores
  that email, so open the Stash inbox in Gmail to click it. Then create a filter
  (`from:` the bank's alert address) → **Forward it to** the Stash address.

Turn on the alerts you want at each bank: **every purchase / authorization**,
and if offered, **transaction posted** (that lets a later tip or final gas
amount update the first alert). Refund and deposit alerts become Income.

> **Joint cards:** only **one** of you should enroll the joint card's alerts.
> Stash catches double enrollment as a duplicate, but avoiding it is cleaner.

> **Venmo:** each person forwards their own Venmo receipts. Stash tells the two
> Venmo accounts apart by whose inbox forwarded the email.

> **Wells Fargo:** the alerts you set up go to whatever address you choose, but
> Bill Pay ("Your payment(s) were sent"), "You made a payment" and "Online
> transfer initiated" always go to your account's main email. Forward those
> with a filter: `from:(billpay@wellsfargo.com OR alerts@notify.wellsfargo.com)`.
> Statements and other notices that come along are ignored.

> **Discover** alerts now come from Capital One (`capitalone@notification.capitalone.com`,
> "Discover by Capital One"), so pick **Capital One / Discover** for both cards —
> the card's last 4 tells them apart.

> **Don't press Forward by hand** to send Stash an alert: a hand-forwarded email
> comes from your Gmail, not the bank, so Stash can't verify it and marks it
> *Unauthenticated*. Only a filter's automatic forward keeps the bank's signature.

## 3. The Apps Script poller

Follow `apps-script/README.md`: paste `poller.gs` and `appsscript.json` into a
new Apps Script project **in the Stash account**, set `STASH_URL` and
`STASH_TOKEN` (create the key in Stash → **Settings → Email sync**), run
`setup`, and approve the permissions.

Settings → Email sync shows **Last check-in** within a minute.

## 4. Tell Stash which account is which

Reconcile → ⋮ → **Accounts** → **alerts** on each account:

- **Email alerts from** — the bank (Stash only lists banks it can read).
- **Card last 4** — for cards and bank accounts.
- **Forwarded from** — for Venmo: the email address of the inbox that forwards it.
- **Bill Pay comes out of this account** — Wells Fargo only, on the one account
  your Bill Pay draws from (its emails never say which).
- **If nobody answers** — keep waiting, or file it as the guess.

Alerts that match no account wait under **Settings → Email sync → Email
activity → Unknown account**. Picking the account there re-reads them — that's
also what you do when a bank mails a replacement card.

In Settings → Email sync, add the **Venmo names that mean "us"** so payments
between the two of you are ignored.

## 5. Shadow first, then live

Email sync starts in **Shadow**: alerts are read and checked, nothing is added.
Keep logging by hand as usual and watch **Email activity → Shadow report**,
which shows what each alert *would* have done next to what you logged that day.

When a week of it matches, switch **Mode → Live**. From then on:

- Purchases appear on their own, filed by your rules. New merchants are asked
  once: **To categorize** (banner on New Expense and Budget).
- A guessed category counts in its budget bar straight away, drawn as a hatched
  **unconfirmed** share, until someone picks.
- Logging a purchase by hand after its alert answers the alert instead of
  doubling it (**Keep both** undoes that).
- Monthly CSV reconciling works exactly as before; alert entries usually match
  by themselves. A tipped or final-gas amount shows **Correct to $X & link**.

Emails that arrived during Shadow are never added later — you logged those by
hand.

## 6. Notifications (optional, per person)

Settings → **Notifications** → **Enable notifications on this device**, then
tick the accounts you want to be asked about. On iPhone this works only from
the **Home Screen** app (Share → Add to Home Screen), iOS 16.4+.

> If you tap **Don't Allow**, iPhone won't ask again. To recover, delete the
> Stash Home Screen icon, add it again from Safari, and enable it again here.

Server setup (once): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
`VAPID_SUBJECT` in Vercel — generate the keys with `npx web-push
generate-vapid-keys`; the subject is `mailto:` plus an address you read.

## When something's off

| You see | Do |
|---|---|
| Last check-in is amber | Open the Apps Script and run `setup` again (re-authorize if asked). |
| "Couldn't read" | Expected until Stash has a reader for that bank. Emails are kept; **Re-read** runs them again once it does. |
| "Unknown account" | Assign it to an account. |
| "Failed sender check" | The email didn't verifiably come from the bank. Never added. |
| A purchase doubled | Delete one, or it's in **Possible duplicates** in To categorize. |
| A tip/gas merge was wrong | Open it → **Split back into two**. |
| A rule filed something wrong | **Rules** → fix the rule → **Apply to past transactions**. |
