import type { NormalizedEmail, ParseResult, Parser } from "@/lib/email/types";
import { cleanName, findDate, moneyToCents, stripEmphasis, valueAfterLabel } from "@/lib/email/parsers/util";

/**
 * Wells Fargo.
 *
 * Version 1 (2026-11-16) is written from real emails — see the `real-*`
 * fixtures — and reads three kinds. Version 2 adds credit card purchases and
 * also reads a plain-text rendering, where bold labels arrive as
 * "*Payment amount*":
 *
 *   "You made a purchase over $1.00"        purchase (pending)
 *       "You made a purchase of $12.34" / "with credit card ...1234" /
 *       "Merchant: NAME in CITY, ST, USA" / "Date: 11/16/2026".
 *       Only CREDIT card ones: a debit card has its own number, not the
 *       checking account's, so routing it by last four would need its own
 *       rule — `unparsed` until a real debit sample exists.
 *   "You just got paid early!"              payment_received → Income (D1)
 *       "$12.34 is now in account ...1234" / "Deposit amount" /
 *       "Deposited by: <ACH line>". The source is the ACH company + entry
 *       description only — never the recipient name that follows the date.
 *       (Version 3, 2026-11-19.)
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
 * Debit card and withdrawal alerts have no real sample yet, and "Your account
 * update is here" (a digest of posted activity, which repeats what the other
 * alerts already said) is deliberately left unread for now. Anything
 * with a dollar amount that isn't one of the above is `unparsed`, so the first
 * real ones land under Couldn't read to build the next version from — never a
 * guess.
 * Statements, FICO, credit-limit and sign-in notices are `ignore`d.
 *
 * A payment TO a card is `transfer`, never `refund` (plan §5.3).
 */

/** The last four of a masked number: "XXXX-XXXX-XXXX-1234", "XXXXXX1234", "****1234". */
const MASKED = /[X*•]{2,}[-X*•]*(\d{4})\b/i;

const AMOUNT = String.raw`\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)`;

/** One line of text, so a sentence wrapped across lines still matches. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** "WAL-MART #1234 in SPRINGFIELD, IL, USA" → "WAL-MART #1234". The LAST " in ". */
function withoutLocation(merchant: string): string {
  const m = /^(.+)\s+in\s+[^,]+,\s*[A-Z]{2}(?:,\s*[A-Z][A-Z .]*)?$/i.exec(merchant.trim());
  return m ? m[1] : merchant;
}

/**
 * "Deposited by: 123456 EXAMPLE CO PAYROLL 261120 0000 PAT Q PUBLIC" — an ACH
 * line: company, entry description, effective date (YYMMDD), an id, then the
 * RECIPIENT's name. Keep only what precedes the date, so the account holder's
 * name and the id never become the source, and drop a leading company number
 * so the default name reads "Example Co Payroll".
 */
function depositSource(raw: string): string {
  const beforeDate = /^(.*?)\s+\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:\s|$)/.exec(raw.trim())?.[1] ?? raw;
  return cleanName(beforeDate.replace(/^\d+\s+(?=\S)/, ""));
}

function parseDeposit(text: string): ParseResult {
  const line = flat(text);
  const amountCents = moneyToCents(valueAfterLabel(text, /^deposit amount\b/i));
  const head = new RegExp(String.raw`${AMOUNT} is now in account\s*(?:\.{2,}|…|[X*•]{2,})\s?(\d{4})\b`, "i").exec(line);
  const by = valueAfterLabel(text, /^deposited by\b/i);
  if (!amountCents) return { unparsed: "wellsfargo_deposit_no_amount" };
  if (!head) return { unparsed: "no_last4" };
  // The headline repeats the amount; if the two disagree, read neither.
  if (moneyToCents(head[1]) !== amountCents) return { unparsed: "wellsfargo_deposit_amount_mismatch" };
  const merchantRaw = by ? depositSource(by) : "";
  if (!merchantRaw) return { unparsed: "wellsfargo_deposit_no_source" };

  return {
    kind: "payment_received",
    amountCents,
    merchantRaw,
    accountHint: { last4: head[2] },
    occurredAt: null,
    // No date in the body except the ACH effective date; the email's own time
    // is when the money became available.
    occurredDate: null,
    isPending: false,
  };
}

function parsePurchase(text: string): ParseResult {
  const m = new RegExp(
    String.raw`you made a purchase of \*?${AMOUNT}\*? with (credit|debit) card\s*(?:\.{2,}|…|[X*•]{2,})\s?(\d{4})\b`,
    "i",
  ).exec(flat(text));
  if (!m) return { unparsed: "wellsfargo_purchase_unrecognized" };
  if (m[2].toLowerCase() !== "credit") return { unparsed: "wellsfargo_debit_card_purchase" };

  const amountCents = moneyToCents(m[1]);
  const merchantLine = valueAfterLabel(text, /^merchant\b/i);
  const merchantRaw = merchantLine ? cleanName(withoutLocation(merchantLine)) : "";
  if (!amountCents) return { unparsed: "no_amount" };
  if (!merchantRaw) return { unparsed: "no_merchant" };
  const date = valueAfterLabel(text, /^date\b/i);

  return {
    kind: "purchase",
    amountCents,
    merchantRaw,
    accountHint: { last4: m[3] },
    occurredAt: null,
    occurredDate: date ? findDate(date) : null,
    // An alert at purchase time is the authorization; a tip can follow.
    isPending: true,
  };
}

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
  // A plain-text rendering shows bold labels as "*Payment amount*".
  const text = stripEmphasis(email.text);
  const all = `${subject}\n${text}`;

  // Offers and newsletters come from mail*.wellsfargo.com, alerts from
  // notify.wellsfargo.com / Billpay@wellsfargo.com.
  if (/@mail\d*\.wellsfargo\.com$/i.test(email.from)) return { ignore: "wellsfargo_marketing" };
  if (/\bdeclined\b/i.test(all)) return { ignore: "declined", kind: "declined" };

  if (/^bill pay\b/i.test(subject) || /@billpay\./i.test(email.from) || /^billpay@/i.test(email.from)) {
    return parseBillPay(text, subject);
  }

  if (/^you made a purchase\b/i.test(subject) || /\byou made a purchase of\b/i.test(text)) {
    return parsePurchase(text);
  }

  if (/\bgot paid early\b/i.test(subject) || (/^deposit amount\b/im.test(text) && /^deposited by\b/im.test(text))) {
    return parseDeposit(text);
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

  // Money, but a layout this version doesn't know (deposit / withdrawal
  // alerts, until real samples exist). Couldn't read, then a parser update.
  return { unparsed: "wellsfargo_unrecognized" };
}

export const wellsFargoParser: Parser = {
  id: "wellsfargo",
  label: "Wells Fargo",
  version: 3,
  senders: [/@(?:[a-z0-9-]+\.)*wellsfargo\.com$/i],
  dkimDomains: ["wellsfargo.com"],
  accountKey: "last4",
  unnumbered: { label: "Bill Pay" },
  parse: parseWellsFargo,
};
