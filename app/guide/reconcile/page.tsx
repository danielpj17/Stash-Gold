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

function B({ children }: { children: ReactNode }) {
  return <strong className="text-white">{children}</strong>;
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
            Check what you logged against what your bank says actually happened.
          </p>
        </header>

        <Section id="setup" title="Setup (once)">
          <ol className="list-decimal pl-5 space-y-1.5">
            <li>
              <Link href="/reconcile" className="text-[#50C878] hover:brightness-110">
                Reconcile
              </Link>{" "}
              → <B>⋮</B> (top right) → <B>Accounts</B> → add each account you use.
            </li>
            <li>
              Set each account&apos;s <B>type</B> — credit cards show purchases as positive, the
              opposite of checking.
            </li>
            <li>
              Set a <B>starting balance</B> — what the account held before your first logged
              transaction. Unknown? Leave 0 and fix it later with an anchor.
            </li>
            <li>
              Log expenses on{" "}
              <Link href="/new-expense" className="text-[#50C878] hover:brightness-110">
                New Expense
              </Link>{" "}
              (or the iOS Shortcut at the bottom of that page), picking the account you paid from.
            </li>
          </ol>
        </Section>

        <Section id="rhythm" title="Each month, per account">
          <ol className="list-decimal pl-5 space-y-1.5">
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

        <Section id="csv" title="First upload for an account">
          <p>
            Stash asks how to read the file and pre-fills a guess. <B>Check it, don&apos;t trust
            it.</B>
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <B>Date</B> — the transaction date.
            </li>
            <li>
              <B>Description</B> — merchant or memo.
            </li>
            <li>
              <B>Amount</B> — the signed amount. If your bank uses separate <B>Debit</B> and{" "}
              <B>Credit</B> columns, set both and leave Amount unset.
            </li>
            <li>
              <B>Purchases show as positive</B> — tick for most credit cards. Wrong = charges filed
              as income.
            </li>
            <li>
              <B>Use the purchase date from the description</B> — for banks that write &quot;PURCHASE
              AUTHORIZED ON 03/14&quot; then post a day later.
            </li>
            <li>
              Watch the preview counter. &quot;3 of 214 rows read&quot; means the mapping is wrong.
            </li>
          </ul>
          <Note>
            Changing an account&apos;s CSV format later clears its cached match results. Your claims
            stay — re-upload or re-match to rebuild the view.
          </Note>
        </Section>

        <Section id="results" title="Where bank rows land">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <B>Matched to sheet</B> — confidently linked to an expense you logged. Nothing to do.
            </li>
            <li>
              <B>Suggested</B> — amount matches, but the date or description isn&apos;t close enough
              to be certain. Approve or reject.
            </li>
            <li>
              <B>Needs an expense</B> — a real charge you never logged.
            </li>
            <li>
              <B>Income / transfers</B> — money in, or movement between your own accounts. Kept
              separate so it doesn&apos;t clutter the queue.
            </li>
            <li>
              <B>Closed on statement</B> — handled previously with no logged entry attached, usually
              dismissed.
            </li>
          </ul>
        </Section>

        <Section id="clearing" title="Clearing the queue">
          <p>
            Every row has a <B>Claim</B> button plus a <B>⋯</B> menu with the rest of its actions.
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <B>Approve match</B> (⋯ menu) — accept one suggestion.
            </li>
            <li>
              <B>Bulk Approve</B> — pick a filter chip (<em>High confidence</em> is the safe one),
              select all visible, approve.
            </li>
            <li>
              <B>Quick add to sheet</B> — logs a missing expense and links it to the bank row in one
              step.
            </li>
            <li>
              <B>Dismiss</B> — for a bank row that will never have a logged entry (fee, refund,
              interest). You&apos;ll be asked for a note. Works in the other direction too, for
              something you logged that will never hit a statement.
            </li>
            <li>
              <B>Claim</B> — link one bank charge to several logged expenses (a $120 shop split into
              Groceries $95 + Household $25). The amounts must add up exactly.
            </li>
          </ul>
        </Section>

        <Section id="editing" title="Fixing an entry you logged">
          <p>Sometimes the entry is what&apos;s wrong — $45 typed for a $45.20 charge, off by a day.</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <B>⋯ → Edit entry</B> — change date, amount, category, description. Saving re-runs
              matching, so it usually links itself on the spot.
            </li>
            <li>
              <B>⋯ → Delete entry</B> — removes it from Stash entirely, dashboard and budgets
              included. For things logged twice or by mistake.
            </li>
          </ul>
          <Note>
            Deleting can&apos;t be undone. If the entry is real but will never appear on a statement,
            dismiss it instead.
          </Note>
        </Section>

        <Section id="transfers" title="Transfers take two legs">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              $500 checking → savings appears on two statements: −$500 and +$500. One transfer, two
              bank rows.
            </li>
            <li>It stays incomplete until you claim both legs, usually across two uploads.</li>
            <li>
              Two legs with the same sign are rejected — that&apos;s almost always a mis-click.
            </li>
            <li>
              Money that left and never landed anywhere you track (a cash withdrawal) is a one-leg
              transfer.
            </li>
          </ul>
        </Section>

        <Section id="memory" title="Recurring charges learn themselves">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              Claim the same merchant twice — Netflix, your gym — and from the third month Stash
              auto-claims it. It never reaches your queue.
            </li>
            <li>
              <B>⋮ → Memory</B> lists everything learned. Delete an entry to stop it auto-claiming.
            </li>
            <li>Memory is per account, so checking patterns don&apos;t fire on your credit card.</li>
          </ul>
        </Section>

        <Section id="anchors" title="Anchors: confirming a balance">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              An anchor says &quot;this account definitely held $X on this date.&quot; It replaces
              the computed balance and ignores everything before it.
            </li>
            <li>
              Use one to start mid-year without importing history, or to reset a balance that has
              drifted.
            </li>
            <li>
              Set it from the account view: <B>⋮ → Ending balance</B>, using the ending balance
              printed on a statement.
            </li>
          </ul>
        </Section>

        <Section id="maintenance" title="Maintenance">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <B>Re-match from sheet</B> — for when you uploaded a statement, then logged the missing
              expenses afterwards.
            </li>
            <li>
              <B>Remove duplicate rows</B> — drops redundant copies left by two overlapping
              statements. Genuine duplicate purchases are kept.
            </li>
            <li>
              <B>✕ next to a file</B> — removes everything that file brought in. For the wrong file
              or the wrong account.
            </li>
            <li>
              <B>⋮ → Activity</B> — every action, each with an Undo. The way back from a bad bulk
              approve.
            </li>
          </ul>
          <Note>
            Uploading the same month twice is safe. A transaction is identified by date, amount and
            description, so overlapping statements collapse instead of double-counting — but two
            genuinely identical charges on one day still count as two.
          </Note>
        </Section>

        <Section id="troubleshooting" title="When something looks wrong">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <B>&quot;No candidate match&quot; on a charge you definitely logged</B> — the entry is
              already claimed by another bank row. Check Matched, disconnect the wrong link,
              re-match.
            </li>
            <li>
              <B>A whole account shows as income</B> — the sign convention is inverted. Toggle
              &quot;purchases show as positive&quot; in that account&apos;s CSV format.
            </li>
            <li>
              <B>Almost no rows were read</B> — the column mapping is wrong. Re-open the CSV format
              and watch the preview counter.
            </li>
            <li>
              <B>Dates are consistently a day or two off</B> — turn on &quot;use the purchase date
              from the description&quot;.
            </li>
          </ul>
        </Section>
      </div>
    </DashboardLayout>
  );
}
