# How to reconcile your accounts

Reconciling means checking two lists against each other:

- **what you logged** — the expenses and transfers you entered in Stash
- **what actually happened** — the transactions on your bank statement

Every bank transaction should have a matching entry you logged, and every entry
you logged should show up on a statement. Reconciling finds the gaps: the coffee
you forgot to log, the subscription you didn't know renewed, the double charge.

You don't have to do this. Stash works fine without it. But a month of
reconciling is what turns "roughly right" numbers into numbers you trust.

---

## Setup (once)

### 1. Add your accounts

**Reconcile → Accounts.** Add each account you want to track — checking, savings,
credit card, a cash-app balance, whatever you actually use. Name them however
you like; the names are just labels and you can change them later without
breaking anything.

Pick the right **type** for each. It matters for credit cards: card statements
usually show purchases as *positive* numbers, the opposite of a checking
account, and Stash uses the type to guess that correctly.

Set a **starting balance**: what the account held before your first logged
transaction. If you don't know, leave it at 0 and fix it later with an anchor
(below).

### 2. Log expenses as you go

Use the **New Expense** page, or set up the iOS Shortcut (the **iOS Shortcut**
box at the bottom of that same page) to log from your phone in a couple of taps. Pick the account you paid
from — that's what lets the expense move the right balance.

Log transfers between your own accounts on the **Budget** page. A transfer isn't
an expense; money moved, it didn't leave.

---

## The monthly rhythm

Once a month, per account:

1. Download the statement CSV from your bank.
2. **Reconcile** → pick the account → drag the file onto the upload zone.
3. Clear whatever lands in the review list.

That's it. Ten minutes for a normal month.

---

## Your first upload for an account

The first time you drop a file for an account, Stash asks how to read it. Banks
don't agree on CSV format, so it needs to know which column is which.

You'll see the first few rows of your actual file with a dropdown above each
column. Stash fills in a guess — **check it, don't trust it.**

Set:

- **Date** — the transaction date
- **Description** — the merchant or memo
- **Amount** — the signed amount

Some banks use two columns instead of one Amount: **Debit** (money out) and
**Credit** (money in). Set both and leave Amount unset.

Two checkboxes:

- **Purchases show as positive numbers.** Tick this for most credit cards. On a
  checking account a purchase is normally negative. Get this wrong and your card
  charges get filed as income.
- **Use the purchase date from the description.** For banks that write
  `PURCHASE AUTHORIZED ON 03/14` and post the charge a day or two later. Using
  the real purchase date makes matching much more accurate.

At the bottom, a **preview** shows how the first few rows actually parse, and a
counter says how many of the file's rows could be read. That counter is the real
signal — if it says "3 of 214 rows read", the mapping is wrong.

Save, and the upload continues. You won't be asked again for that account.

> Changing an account's CSV format later clears its cached match results,
> because the mapping determines each transaction's identity. Your claims stay;
> re-upload or re-match to rebuild the view.

---

## Reading the results

After an upload, bank rows land in one of three places.

**Matched to sheet** — Stash is confident this bank row is the expense you
logged. Nothing to do.

**Unmatched / Suggested** — needs your eyes. Within it:

- *Suggested* — the amount matches something you logged, but the date or
  description isn't close enough to be sure. Approve or reject.
- *Needs an expense* — a real charge you never logged. Add it.
- *Income / transfers* — money in, or movement between your own accounts.
  Usually nothing to do; these are separated out so they don't clutter the
  "needs an expense" queue.

**Closed on statement** — handled in a previous session, with no logged entry
attached (usually because you dismissed it).

---

## Clearing the queue

Every row carries a **Claim** button plus a **⋯** menu holding the rest of its
actions.

**Approve one at a time** with *Approve match* in the row's ⋯ menu, or use
**Bulk Approve**: select a filter chip (*High confidence* is the safe one), tick
"select all visible", and approve the lot.

**Add a missing expense** with *Quick add to sheet* in the ⋯ menu of an unmatched
row. It logs the expense *and* links it to that bank row in one step.

**Dismiss** a bank row that will never have a logged entry — a bank fee, a
refund, interest. You'll be asked for a short note so future-you knows why.

You can also dismiss in the other direction: an entry you logged that will never
appear on a statement (cash you handed someone, a reimbursement that netted
out).

---

## Fixing an entry you logged

Sometimes the reason a row won't match is the entry itself: you typed $45 when
the charge was $45.20, dated it a day late, or filed it under the wrong
category.

Open the ⋯ menu on the entry and pick **Edit entry**. You can change its date,
amount, category and description. Saving re-runs matching, so a corrected entry
usually links itself on the spot.

**Delete entry** in the same menu removes the transaction from Stash entirely —
dashboard totals and budgets included. Use it for something logged twice or by
mistake. If the entry is real but will simply never appear on a statement,
dismiss it instead; deleting can't be undone.

---

## Transfers take two legs

Move $500 from checking to savings and it appears on *two* statements: -$500 on
one, +$500 on the other. That's one transfer, two bank rows.

So a transfer stays "incomplete" until you've claimed both legs — usually across
two separate uploads. Stash tracks how many legs it has and won't let you claim
two legs with the same sign, which is the usual sign of a mis-click.

If money left an account and genuinely never landed anywhere you track (cash
withdrawal), claim it as a one-leg transfer.

---

## Split charges

One bank charge can cover several logged expenses — a $120 supermarket run split
into Groceries $95 and Household $25. Use the **Claim** button on the bank row,
tick the entries it covers, and Stash checks the amounts add up to the charge
exactly before linking them.

---

## Recurring charges learn themselves

Claim the same merchant twice — Netflix, your gym, a subscription — and Stash
remembers the pattern. From the third month on it auto-claims that charge and it
never reaches your review queue.

The **Memory** button lists everything it has learned. Delete an entry to stop
it auto-claiming (useful if a subscription's price changed or you cancelled it).

Memory is per account: a pattern learned on your checking account won't fire on
your credit card.

---

## Anchors: confirming a balance

An **anchor** is you telling Stash "this account definitely held $X on this
date." It replaces the computed balance and ignores everything before that date.

Use one when:

- You're starting mid-year and don't want to import a decade of history.
- Your computed balance has drifted from reality and you want to reset it.

Set it from the account view on the Reconcile page, using the ending balance
printed on a statement. From that date forward, Stash resumes counting your
logged transactions.

---

## Maintenance

**Re-match from sheet** — you uploaded a statement, then logged the missing
expenses afterwards. Re-match re-runs matching against your current entries;
exact matches link automatically, the rest become suggestions.

**Remove duplicate rows** — you uploaded two overlapping statements and the same
transaction appears twice, once matched and once not. This drops the redundant
copies. Genuine duplicate purchases (two identical coffees) are kept.

**Clear a file** — the ✕ next to an uploaded file name. Removes everything that
file brought in: its matches, claims, dismissals. Use it if you uploaded the
wrong file or the wrong account.

**Activity** — a log of every reconciliation action, each with an **Undo**.
If you bulk-approved something you shouldn't have, this is the way back.

---

## Uploading the same month twice is safe

Statements overlap; that's normal. Stash identifies a transaction by its date,
amount, and cleaned description, so re-uploading a period you've already
imported collapses onto what's already there instead of double-counting.

Two genuinely identical transactions on the same day (two $4.50 coffees) are
still treated as two — they're real, and both need matching.

---

## When something looks wrong

**"No candidate match" on a charge I definitely logged.** The entry is probably
already claimed by another bank row. Check the Matched section, disconnect the
wrong link, then re-match.

**Everything from one account shows as income.** The sign convention is
inverted. Reconcile → Accounts → re-open that account's CSV format and toggle
"purchases show as positive".

**Almost no rows were read from my file.** The column mapping is wrong. Re-open
the CSV format for that account and check the preview counter.

**Dates are consistently a day or two off.** Turn on "use the purchase date from
the description" if your bank embeds it, or expect matching to lean on amount
and description instead — it still works, just with less confidence.
