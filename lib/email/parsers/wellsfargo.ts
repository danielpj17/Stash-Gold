import type { NormalizedEmail, ParseResult, Parser } from "@/lib/email/types";
import { partOf } from "@/lib/email/parts";
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
 *   "Your account update is here"           posted activity (v4, 2026-11-19)
 *       Deposits / Withdrawals for one account, each a description and an
 *       amount. Several → `{ split }`: one event per line (lib/email/parts.ts).
 *       Each line is `postedSummary`: it repeats what other alerts and hand
 *       entries usually recorded already, and decide() checks that first.
 *       A payment to a card issuer or an online transfer is a transfer;
 *       rewards are a transfer from "Other"; other withdrawals are expenses
 *       and other deposits Income.
 *
 * Debit card alerts have no real sample yet. Anything
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

// ---- "Your account update is here": a summary of POSTED activity -----------

/** A payment from checking to a card: a transfer, never an expense. */
const CARD_PAYMENT =
  /^(?:CAPITAL ONE|DISCOVER|WELLS FARGO CARD|WF CREDIT CARD|CHASE CREDIT CRD|CITI ?CARD|CITI AUTOPAY|AMEX|AMERICAN EXPRESS|BARCLAYCARD|SYNCHRONY|APPLECARD|BANK OF AMERICA|BK OF AMER)\b.*\b(?:PMT|PAYMENT|E-?PAYMENT|EPAY|AUTO ?PAY|AUTOPAY)\b/i;
const ONLINE_TRANSFER = /^(?:ONLINE|RECURRING|MOBILE) TRANSFER\b/i;
const REWARDS = /\bREWARDS?\b/i;

type SummaryItem = { direction: "in" | "out"; description: string; amountCents: number };

/** "…261117…" — an ACH effective date (YYMMDD) in a posted description. */
const ACH_DATE = /^\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;

/**
 * The payee/payer part of a posted description. ACH lines run on into a date,
 * an id and the ACCOUNT HOLDER'S name ("Ch Example DONATION 261117 XXXXX1234
 * PAT Q PUBLIC", "CAPITAL ONE ONLINE PMT CA1234567890 Pat Q Public"), so cut at
 * the first date or id-like token (6+ characters with a digit, or masked) —
 * never at the first word.
 */
function summarySource(description: string): string {
  const tokens = description.trim().split(/\s+/);
  const cut = tokens.findIndex(
    (t, i) => i > 0 && (ACH_DATE.test(t) || /^X{2,}\d+$/i.test(t) || (t.length >= 6 && /\d/.test(t) && /^[A-Z0-9]+$/i.test(t))),
  );
  return cleanName((cut > 0 ? tokens.slice(0, cut) : tokens).join(" "));
}

function achDate(description: string): string | null {
  const t = description.trim().split(/\s+/).find((x, i) => i > 0 && ACH_DATE.test(x));
  return t ? `20${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}` : null;
}

function summaryAlert(item: SummaryItem, last4: string, asOf: string | null): ParseResult {
  const merchantRaw = summarySource(item.description);
  if (!merchantRaw) return { unparsed: "no_merchant" };
  const base = {
    amountCents: item.amountCents,
    merchantRaw,
    accountHint: { last4 },
    occurredAt: null,
    occurredDate: achDate(item.description) ?? asOf,
    isPending: false,
    postedSummary: true as const,
  };
  const other = MASKED.exec(item.description)?.[1];
  if (item.direction === "out") {
    if (CARD_PAYMENT.test(item.description) || ONLINE_TRANSFER.test(item.description)) {
      return { ...base, kind: "transfer", transferDirection: "out", ...(other ? { fundingSource: { last4: other } } : {}) };
    }
    return { ...base, kind: "posted" };
  }
  if (ONLINE_TRANSFER.test(item.description)) {
    return { ...base, kind: "transfer", transferDirection: "in", ...(other ? { fundingSource: { last4: other } } : {}) };
  }
  if (REWARDS.test(item.description)) return { ...base, kind: "transfer", transferDirection: "in", externalFrom: "Other" };
  return { ...base, kind: "payment_received" };
}

/**
 * "Here's the rundown / for account ...1234 / Deposits / <description> /
 * $12.34 / Withdrawals / <description> / $5.67 / As of 11/17/2026 at …".
 * Strict: anything but description-then-amount pairs under those two
 * headings is `unparsed`. Several items → `{ split }`, and each part reads
 * its own item.
 */
function parseAccountUpdate(email: NormalizedEmail, text: string): ParseResult {
  const last4 = new RegExp(String.raw`for account\s*(?:\.{2,}|…|[X*•]{2,})\s?(\d{4})\b`, "i").exec(flat(text))?.[1];
  if (!last4) return { unparsed: "no_last4" };
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const end = lines.findIndex((l) => /^as of\b/i.test(l));
  if (end < 0) return { unparsed: "wellsfargo_update_no_date" };
  const asOf = findDate(lines[end]);

  const items: SummaryItem[] = [];
  let direction: SummaryItem["direction"] | null = null;
  let description: string | null = null;
  for (const line of lines.slice(0, end)) {
    if (/^deposits?$/i.test(line) || /^withdrawals?$/i.test(line)) {
      if (description) return { unparsed: "wellsfargo_update_description_without_amount" };
      direction = /^deposit/i.test(line) ? "in" : "out";
      continue;
    }
    if (!direction) continue; // "Here's the rundown", "for account …", "Go to accounts"
    if (/^\*?\$\s?[\d,]+\.\d{2}\*?$/.test(line)) {
      const amountCents = moneyToCents(line.replace(/\*/g, ""));
      if (!description || !amountCents) return { unparsed: "wellsfargo_update_amount_without_description" };
      items.push({ direction, description, amountCents });
      description = null;
      continue;
    }
    if (description) return { unparsed: "wellsfargo_update_unrecognized_line" };
    description = line;
  }
  if (description) return { unparsed: "wellsfargo_update_description_without_amount" };
  if (items.length === 0) return { ignore: "wellsfargo_update_empty" };

  const part = partOf(email.gmailMessageId);
  if (part === null) return items.length === 1 ? summaryAlert(items[0], last4, asOf) : { split: items.length };
  const item = items[part - 1];
  return item ? summaryAlert(item, last4, asOf) : { unparsed: "wellsfargo_update_part_missing" };
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

  if (/\baccount update is here\b/i.test(subject) || /^here'?s the rundown\b/im.test(text)) {
    return parseAccountUpdate(email, text);
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
  version: 4,
  senders: [/@(?:[a-z0-9-]+\.)*wellsfargo\.com$/i],
  dkimDomains: ["wellsfargo.com"],
  accountKey: "last4",
  unnumbered: { label: "Bill Pay" },
  parse: parseWellsFargo,
};
