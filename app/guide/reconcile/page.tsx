import type { ReactNode } from "react";
import Link from "next/link";
import DashboardLayout from "@/components/DashboardLayout";

export const metadata = {
  title: "How reconciling works · Stash",
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="text-white font-semibold text-lg mb-2">{title}</h2>
      <div className="space-y-3 text-sm text-gray-300 leading-relaxed">{children}</div>
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs text-gray-400 border-l-2 border-charcoal-dark pl-3">{children}</p>
  );
}

export default function ReconcileGuidePage() {
  return (
    <DashboardLayout>
      <div className="max-w-2xl space-y-8 pb-12">
        <header className="space-y-2">
          <h1 className="text-white text-2xl font-semibold">How reconciling works</h1>
          <p className="text-sm text-gray-400">
            Checking what you logged against what your bank says actually happened — so the
            numbers are ones you can trust.
          </p>
        </header>

        <Section id="setup" title="Setup (once)">
          <p>
            <strong className="text-white">Add your accounts.</strong>{" "}
            <Link href="/reconcile" className="text-[#50C878] hover:brightness-110">
              Reconcile
            </Link>{" "}
            → the <strong className="text-white">⋮</strong> menu (top right) →{" "}
            <strong className="text-white">Accounts</strong>. Add each account you actually use — checking, savings, credit card, cash app. Name
            them however you like; names are labels and can change later without breaking
            anything.
          </p>
          <p>
            Pick the right <strong className="text-white">type</strong>. It matters for credit
            cards: card statements usually show purchases as <em>positive</em> numbers, the
            opposite of a checking account.
          </p>
          <p>
            Set a <strong className="text-white">starting balance</strong> — what the account held
            before your first logged transaction. If you don&apos;t know, leave it at 0 and fix it
            later with an anchor.
          </p>
          <p>
            <strong className="text-white">Log as you go.</strong> Use{" "}
            <Link href="/new-expense" className="text-[#50C878] hover:brightness-110">
              New Expense
            </Link>{" "}
            — or the <strong className="text-white">iOS Shortcut</strong> box at the bottom of
            that same page. Pick the account you paid from — that&apos;s what lets it move the right balance.
          </p>
        </Section>

        <Section id="rhythm" title="The monthly rhythm">
          <p>Once a month, per account:</p>
          <ol className="list-decimal pl-5 space-y-1">
            <li>Download the statement CSV from your bank.</li>
            <li>
              <Link href="/reconcile" className="text-[#50C878] hover:brightness-110">
                Reconcile
              </Link>{" "}
              → pick the account → drag the file onto the upload zone.
            </li>
            <li>Clear whatever lands in the review list.</li>
          </ol>
          <p>Ten minutes for a normal month.</p>
        </Section>

        <Section id="csv" title="Your first upload for an account">
          <p>
            The first time you drop a file for an account, Stash asks how to read it — banks
            don&apos;t agree on CSV format. You&apos;ll see the first rows of your actual file with
            a dropdown above each column, pre-filled with a guess.{" "}
            <strong className="text-white">Check it, don&apos;t trust it.</strong>
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong className="text-white">Date</strong> — the transaction date
            </li>
            <li>
              <strong className="text-white">Description</strong> — merchant or memo
            </li>
            <li>
              <strong className="text-white">Amount</strong> — the signed amount. Some banks use{" "}
              <strong className="text-white">Debit</strong> and{" "}
              <strong className="text-white">Credit</strong> columns instead; set both and leave
              Amount unset.
            </li>
          </ul>
          <p>Two checkboxes matter:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong className="text-white">Purchases show as positive.</strong> Tick for most
              credit cards. Get it wrong and card charges get filed as income.
            </li>
            <li>
              <strong className="text-white">Use the purchase date from the description.</strong>{" "}
              For banks that write &quot;PURCHASE AUTHORIZED ON 03/14&quot; then post a day later.
            </li>
          </ul>
          <p>
            The preview at the bottom shows how rows actually parse, and a counter says how many
            of the file&apos;s rows could be read. That counter is the real signal — &quot;3 of 214
            rows read&quot; means the mapping is wrong.
          </p>
          <Note>
            Changing an account&apos;s CSV format later clears its cached match results, because
            the mapping determines each transaction&apos;s identity. Your claims stay — re-upload
            or re-match to rebuild the view.
          </Note>
        </Section>

        <Section id="results" title="Reading the results">
          <p>Bank rows land in one of three places.</p>
          <p>
            <strong className="text-white">Matched to sheet</strong> — Stash is confident this is
            the expense you logged. Nothing to do.
          </p>
          <p>
            <strong className="text-white">Unmatched / Suggested</strong> — needs your eyes.
            <em> Suggested</em> means the amount matches but the date or description isn&apos;t
            close enough to be certain. <em>Needs an expense</em> is a real charge you never
            logged. <em>Income / transfers</em> is money in or movement between your own accounts —
            separated out so it doesn&apos;t clutter the queue.
          </p>
          <p>
            <strong className="text-white">Closed on statement</strong> — handled previously, with
            no logged entry attached (usually dismissed).
          </p>
        </Section>

        <Section id="clearing" title="Clearing the queue">
          <p>
            Every row carries a <strong className="text-white">Claim</strong> button plus a{" "}
            <strong className="text-white">⋯</strong> menu holding the rest of its actions.
          </p>
          <p>
            Approve rows one at a time with <em>Approve match</em> in that menu, or use{" "}
            <strong className="text-white">Bulk Approve</strong> — pick a filter chip (
            <em>High confidence</em> is the safe one), select all visible, approve.
          </p>
          <p>
            <strong className="text-white">Quick add to sheet</strong> on an unmatched row logs the
            missing expense and links it to that bank row in one step.
          </p>
          <p>
            <strong className="text-white">Dismiss</strong> a bank row that will never have a
            logged entry — a fee, a refund, interest. You&apos;ll be asked for a note so future-you
            knows why. You can dismiss in the other direction too: something you logged that will
            never hit a statement, like cash handed to a friend.
          </p>
        </Section>

        <Section id="editing" title="Fixing an entry you logged">
          <p>
            Sometimes the reason a row won&apos;t match is the entry itself: you typed $45 when the
            charge was $45.20, dated it a day late, or filed it under the wrong category.
          </p>
          <p>
            Open the <strong className="text-white">⋯</strong> menu on the entry and pick{" "}
            <strong className="text-white">Edit entry</strong> to change its date, amount, category
            and description. Saving re-runs matching, so a corrected entry usually links itself on
            the spot.
          </p>
          <p>
            <strong className="text-white">Delete entry</strong> in the same menu removes the
            transaction from Stash entirely — dashboard totals and budgets included. Use it for
            something logged twice or by mistake.
          </p>
          <Note>
            Deleting can&apos;t be undone. If the entry is real but will simply never appear on a
            statement, dismiss it instead.
          </Note>
        </Section>

        <Section id="transfers" title="Transfers take two legs">
          <p>
            Move $500 from checking to savings and it appears on two statements: −$500 on one,
            +$500 on the other. One transfer, two bank rows — so it stays incomplete until
            you&apos;ve claimed both legs, usually across two uploads.
          </p>
          <p>
            Stash won&apos;t let you claim two legs with the same sign, which is the usual sign of
            a mis-click. If money genuinely left and never landed anywhere you track (a cash
            withdrawal), claim it as a one-leg transfer.
          </p>
        </Section>

        <Section id="splits" title="Split charges">
          <p>
            One bank charge can cover several logged expenses — a $120 supermarket run split into
            Groceries $95 and Household $25. Use the <strong className="text-white">Claim</strong>{" "}
            button on the bank row, tick the entries it covers, and Stash checks the amounts add up
            exactly before linking.
          </p>
        </Section>

        <Section id="memory" title="Recurring charges learn themselves">
          <p>
            Claim the same merchant twice — Netflix, your gym — and Stash remembers the pattern.
            From the third month it auto-claims that charge and it never reaches your queue.
          </p>
          <p>
            <strong className="text-white">⋮</strong> →{" "}
            <strong className="text-white">Memory</strong> lists everything learned;
            delete an entry to stop it auto-claiming. Memory is per account, so a pattern learned
            on checking won&apos;t fire on your credit card.
          </p>
        </Section>

        <Section id="anchors" title="Anchors: confirming a balance">
          <p>
            An anchor is you telling Stash &quot;this account definitely held $X on this
            date.&quot; It replaces the computed balance and ignores everything before that date.
          </p>
          <p>
            Use one when you&apos;re starting mid-year and don&apos;t want to import years of
            history, or when the computed balance has drifted and you want to reset it. Set it from
            the account view via <strong className="text-white">⋮</strong> →{" "}
            <strong className="text-white">Ending balance</strong>, using the ending balance printed
            on a statement.
          </p>
        </Section>

        <Section id="maintenance" title="Maintenance">
          <p>
            <strong className="text-white">Re-match from sheet</strong> — you uploaded a statement,
            then logged the missing expenses afterwards. Re-runs matching against your current
            entries.
          </p>
          <p>
            <strong className="text-white">Remove duplicate rows</strong> — two overlapping
            statements left the same transaction twice, once matched and once not. Drops the
            redundant copies; genuine duplicate purchases are kept.
          </p>
          <p>
            <strong className="text-white">Clear a file</strong> — the ✕ next to a file name
            removes everything it brought in. Use it if you uploaded the wrong file or the wrong
            account.
          </p>
          <p>
            <strong className="text-white">⋮</strong> →{" "}
            <strong className="text-white">Activity</strong> — a log of every action, each with an
            Undo. If you bulk-approved something you shouldn&apos;t have, this is the way back.
          </p>
        </Section>

        <Section id="overlap" title="Uploading the same month twice is safe">
          <p>
            Statements overlap; that&apos;s normal. A transaction is identified by its date,
            amount and cleaned description, so re-uploading a period you&apos;ve already imported
            collapses onto what&apos;s there instead of double-counting. Two genuinely identical
            transactions on one day are still treated as two — they&apos;re real, and both need
            matching.
          </p>
        </Section>

        <Section id="troubleshooting" title="When something looks wrong">
          <p>
            <strong className="text-white">
              &quot;No candidate match&quot; on a charge I definitely logged.
            </strong>{" "}
            The entry is probably already claimed by another bank row. Check the Matched section,
            disconnect the wrong link, then re-match.
          </p>
          <p>
            <strong className="text-white">Everything from one account shows as income.</strong>{" "}
            The sign convention is inverted — re-open that account&apos;s CSV format and toggle
            &quot;purchases show as positive&quot;.
          </p>
          <p>
            <strong className="text-white">Almost no rows were read from my file.</strong> The
            column mapping is wrong. Re-open the CSV format and watch the preview counter.
          </p>
          <p>
            <strong className="text-white">Dates are consistently a day or two off.</strong> Turn
            on &quot;use the purchase date from the description&quot; if your bank embeds it.
          </p>
        </Section>
      </div>
    </DashboardLayout>
  );
}
