import type { ReactNode } from "react";
import Link from "next/link";
import DashboardLayout from "@/components/DashboardLayout";

export const metadata = {
  title: "Setting up email sync · Stash",
};

/** Mirrors docs/email-sync-setup.md — keep the two in step. */

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
  return <p className="text-xs text-gray-400 border-l-2 border-charcoal-dark pl-3">{children}</p>;
}

function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-[#50C878] hover:brightness-110">
      {children}
    </Link>
  );
}

export default function EmailSyncGuidePage() {
  return (
    <DashboardLayout>
      <div className="max-w-2xl space-y-8 pb-12">
        <header className="space-y-2">
          <h1 className="text-white text-2xl font-semibold">Setting up email sync</h1>
          <p className="text-sm text-gray-400">
            Bank, card and Venmo alert emails land in one dedicated Gmail inbox. A small Apps Script forwards
            each one to Stash, which turns it into a transaction, files it by your merchant rules, and asks
            when it can&apos;t.
          </p>
        </header>

        <Section id="gmail" title="1. A dedicated Gmail account">
          <p>
            Create a new Gmail account just for Stash. Give it a <B>unique password</B> and turn on{" "}
            <B>2-Step Verification</B> — it will hold every purchase both of you make.
          </p>
        </Section>

        <Section id="alerts" title="2. Get alerts into that inbox">
          <p>For each bank, card and Venmo account, either:</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <B>Send alerts straight to the Stash address</B>, if the bank lets you add an alert email; or
            </li>
            <li>
              <B>Forward from your own inbox</B> with a Gmail filter: your Gmail → Settings → Forwarding and
              POP/IMAP → add the Stash address, confirm it from the Stash inbox, then create a filter (from: the
              bank&apos;s alert address) → Forward it to the Stash address.
            </li>
          </ul>
          <p>
            Turn on <B>every purchase</B> alerts and, if offered, <B>transaction posted</B> — that lets a later
            tip or final gas amount update the first alert. Refunds and deposits become Income. A deposit is
            named after whoever paid it; rename a paycheck&apos;s source once under Rules → Money in.
          </p>
          <Note>Joint cards: only one of you should enroll the card&apos;s alerts.</Note>
          <Note>Venmo: each person forwards their own receipts. Stash tells the Venmo accounts apart by whose inbox forwarded them.</Note>
        </Section>

        <Section id="poller" title="3. The Apps Script poller">
          <p>
            In the Stash account, create an Apps Script project from <code>apps-script/poller.gs</code> and{" "}
            <code>appsscript.json</code>, set <code>STASH_URL</code> and <code>STASH_TOKEN</code> (create the key in{" "}
            <A href="/settings#email-sync">Settings → Email sync</A>), and run <code>setup</code>. The full steps
            are in <code>apps-script/README.md</code>. Settings shows <B>Last check-in</B> within a minute.
          </p>
        </Section>

        <Section id="accounts" title="4. Tell Stash which account is which">
          <p>
            <A href="/reconcile">Reconcile</A> → ⋮ → <B>Accounts</B> → <B>alerts</B> on each account: the bank,
            the card&apos;s last 4 (or, for Venmo, whose inbox forwards it), and what happens if nobody answers.
          </p>
          <p>
            Alerts that match no account wait under <A href="/settings/email-sync">Email activity → Unknown account</A>.
            Picking the account there re-reads them — that&apos;s also the replacement-card flow.
          </p>
          <p>
            In Settings → Email sync, add the <B>Venmo and Zelle names that mean &quot;us&quot;</B> so money
            between you is ignored.
          </p>
        </Section>

        <Section id="shadow" title="5. Shadow first, then live">
          <p>
            Email sync starts in <B>Shadow</B>: alerts are read and checked, nothing is added. Keep logging by
            hand and watch <A href="/settings/email-sync">Email activity → Shadow report</A>. When a week of it
            matches, switch <B>Mode → Live</B>.
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              New merchants are asked once in <A href="/categorize">To categorize</A> (a banner on New Expense and
              Budget). Set a rule there or on the <A href="/rules">Rules</A> page.
            </li>
            <li>
              A guessed category counts in its budget bar straight away, drawn as a hatched{" "}
              <span className="text-yellow-200/90">unconfirmed</span> share, until someone picks.
            </li>
            <li>Logging a purchase by hand after its alert answers the alert instead of doubling it.</li>
            <li>
              Card alerts come at the swipe, before the tip. Type the total in <B>Final amount, with tip</B> when you
              categorize it (or tap <B>Add a tip or final amount</B>), or log the total by hand.
            </li>
            <li>
              CSV reconciling works as before; a tip nobody entered offers <B>Correct to $X &amp; link</B>.
            </li>
          </ul>
          <Note>Emails that arrived during Shadow are never added later — you logged those by hand.</Note>
        </Section>

        <Section id="notifications" title="6. Notifications (optional, per person)">
          <p>
            <A href="/settings#notifications">Settings → Notifications</A> → Enable, then tick the accounts you
            want to be asked about. On iPhone this works only from the Home Screen app (iOS 16.4+).
          </p>
          <Note>
            If you tap Don&apos;t Allow, iPhone won&apos;t ask again. Delete the Home Screen icon, add it again from
            Safari, then enable it here.
          </Note>
        </Section>

        <Section id="trouble" title="When something's off">
          <ul className="list-disc pl-5 space-y-1.5">
            <li><B>Check-in amber</B> — open the Apps Script and run <code>setup</code> again.</li>
            <li><B>Couldn&apos;t read</B> — expected until Stash can read that bank; Re-read runs them again later.</li>
            <li><B>Unknown account</B> — assign it to an account.</li>
            <li><B>Failed sender check</B> — didn&apos;t verifiably come from the bank; never added.</li>
            <li><B>A wrong tip/gas merge</B> — open it → Split back into two.</li>
            <li><B>A rule filed something wrong</B> — Rules → fix it → Apply to past transactions.</li>
          </ul>
        </Section>
      </div>
    </DashboardLayout>
  );
}
