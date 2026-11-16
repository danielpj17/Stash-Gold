import type { NormalizedEmail, ParseResult, Parser } from "@/lib/email/types";
import { cleanName, findDate, moneyToCents, valueAfterLabel } from "@/lib/email/parsers/util";

/**
 * Wells Fargo.
 *
 * Version 1 (2026-11-16) is written from real emails — see the `real-*`
 * fixtures — and reads three kinds:
 *
 *   "Bill Pay: Your payment(s) were sent"   payment_sent → an expense
 *       Payee / Amount / Sent on. It never says which account paid ("your
 *       selected account(s)"), so it routes to the account ticked "Bill Pay
 *       comes out of this account" (`unnumbered`, migration 008).
 *   "You made a payment"                    transfer, out
 *       To account / From account (both masked, last four) / Payment amount.
 *       A card payment, e.g. checking → the Wells Fargo card.
 *   "Online transfer initiated"             transfer, out
 *       To Account / From Account / Amount / Date. E.g. checking → savings.
 *
 * Transfers name BOTH accounts, so decide() creates one complete transfer.
 *
 * Purchase, deposit and withdrawal alerts have no real sample yet. Anything
 * with a dollar amount that isn't one of the above is `unparsed`, so the first
 * real ones land under Couldn't read to build v2 from — never a guess.
 * Statements, FICO, credit-limit and sign-in notices are `ignore`d.
 *
 * A payment TO a card is `transfer`, never `refund` (plan §5.3).
 */

/** The last four of a masked number: "XXXX-XXXX-XXXX-1234", "XXXXXX1234", "****1234". */
const MASKED = /[X*•]{2,}[-X*•]*(\d{4})\b/i;

/**
 * The masked account number that follows `label`, before `stop`. Wells Fargo
 * puts the label and the number on one line ("To Account XXXXXX1234") in some
 * emails and on separate lines (with "Wells Fargo" between) in others.
 */
function maskedAfter(text: string, label: RegExp, stop: RegExp): string | null {
  const start = label.exec(text);
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const end = stop.exec(rest);
  const segment = rest.slice(0, end ? end.index : 200);
  return MASKED.exec(segment)?.[1] ?? null;
}

function parseBillPay(text: string, subject: string): ParseResult {
  if (!/payment\(?s?\)?\s+(?:were|was)\s+sent/i.test(`${subject}\n${text}`)) {
    return { unparsed: "wellsfargo_billpay_unrecognized" };
  }
  // One email can list several payments; each needs its own row, which one
  // alert can't express. Rare — leave it for a person rather than half-read it.
  const payees = text.split("\n").filter((l) => /^payee name or nickname\b/i.test(l.trim()));
  if (payees.length !== 1) return { unparsed: "wellsfargo_billpay_multiple_payments" };

  const payee = valueAfterLabel(text, /^payee name or nickname\b/i);
  const amountCents = moneyToCents(valueAfterLabel(text, /^amount\b/i));
  if (!payee) return { unparsed: "wellsfargo_billpay_no_payee" };
  if (!amountCents) return { unparsed: "wellsfargo_billpay_no_amount" };
  const sentOn = valueAfterLabel(text, /^sent on\b/i);

  return {
    kind: "payment_sent",
    amountCents,
    merchantRaw: cleanName(payee),
    accountHint: {}, // never named — routed by `unnumbered`
    occurredAt: null,
    occurredDate: sentOn ? findDate(sentOn) : null,
    isPending: false,
  };
}

function parseTransfer(
  text: string,
  labels: { to: RegExp; from: RegExp; amount: RegExp; dateFrom: RegExp },
  merchantRaw: string,
): ParseResult {
  const to = maskedAfter(text, labels.to, labels.from);
  const from = maskedAfter(text, labels.from, labels.amount);
  const amountCents = moneyToCents(valueAfterLabel(text, labels.amount));
  if (!amountCents) return { unparsed: "wellsfargo_transfer_no_amount" };
  if (!from) return { unparsed: "wellsfargo_transfer_no_from_account" };
  if (!to) return { unparsed: "wellsfargo_transfer_no_to_account" };
  if (to === from) return { unparsed: "wellsfargo_transfer_same_account" };

  const dateAt = labels.dateFrom.exec(text);
  const occurredDate = dateAt ? findDate(text.slice(dateAt.index, dateAt.index + 120)) : null;

  return {
    kind: "transfer",
    transferDirection: "out",
    amountCents,
    merchantRaw,
    accountHint: { last4: from },
    fundingSource: { last4: to },
    occurredAt: null,
    occurredDate,
    isPending: false,
  };
}

export function parseWellsFargo(email: NormalizedEmail): ParseResult {
  const subject = email.subject.trim();
  const text = email.text;
  const all = `${subject}\n${text}`;

  // Offers and newsletters come from mail*.wellsfargo.com, alerts from
  // notify.wellsfargo.com / Billpay@wellsfargo.com.
  if (/@mail\d*\.wellsfargo\.com$/i.test(email.from)) return { ignore: "wellsfargo_marketing" };
  if (/\bdeclined\b/i.test(all)) return { ignore: "declined", kind: "declined" };

  if (/^bill pay\b/i.test(subject) || /@billpay\./i.test(email.from) || /^billpay@/i.test(email.from)) {
    return parseBillPay(text, subject);
  }

  if (/\byou made a payment\b/i.test(subject) || /\byou recently submitted a payment\b/i.test(text)) {
    return parseTransfer(
      text,
      {
        to: /^to account\b/im,
        from: /^from account\b/im,
        amount: /^payment amount\b/im,
        dateFrom: /effective as of/i,
      },
      "Wells Fargo payment",
    );
  }

  if (/\bonline transfer\b/i.test(subject) || /\byour transfer is being processed\b/i.test(text)) {
    return parseTransfer(
      text,
      {
        to: /^to account\b/im,
        from: /^from account\b/im,
        amount: /^amount\b/im,
        dateFrom: /^date\b/im,
      },
      "Wells Fargo online transfer",
    );
  }

  // Not a transaction: statements (which quote balances), credit-limit news,
  // FICO, sign-in / contact-detail notices.
  if (/\bstatement\b/i.test(subject)) return { ignore: "wellsfargo_statement" };
  if (/\bcredit limit\b/i.test(subject)) return { ignore: "wellsfargo_notice" };
  if (!/\$\s?\d/.test(all)) return { ignore: "wellsfargo_notice" };

  // Money, but a layout v1 doesn't know (purchase / deposit / withdrawal
  // alerts, until real samples exist). Couldn't read, then a parser update.
  return { unparsed: "wellsfargo_unrecognized" };
}

export const wellsFargoParser: Parser = {
  id: "wellsfargo",
  label: "Wells Fargo",
  version: 1,
  senders: [/@(?:[a-z0-9-]+\.)*wellsfargo\.com$/i],
  dkimDomains: ["wellsfargo.com"],
  accountKey: "last4",
  unnumbered: { label: "Bill Pay" },
  parse: parseWellsFargo,
};
