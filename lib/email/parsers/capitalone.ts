import type { NormalizedEmail, ParseResult, Parser } from "@/lib/email/types";
import { cleanName, findDate, findLast4, moneyToCents, stripEmphasis } from "@/lib/email/parsers/util";

/**
 * Capital One — and Discover, which Capital One now owns. Discover cards'
 * alerts come from the same capitalone@notification.capitalone.com with the
 * same template ("Discover by Capital One", "Discover it Card ending in …"),
 * so one parser reads both and the last four tells the cards apart.
 *
 * Version 1 (2026-11-16) is written from real alerts — see the `real-*`
 * fixtures. Version 2 also reads a plain-text rendering, where bold labels
 * arrive as "*Posted date:*":
 *
 *   "A new transaction was charged to your account"   purchase (pending)
 *       "As requested, we're notifying you that on Nov. 16, 2026, at
 *        CAFE RIO 0002 SPRINGFIELD, a pending authorization or purchase in the
 *        amount of $9.87 was placed or charged on your … Card."
 *       The card is "About your … Card ending in 1234".
 *   "We've received your payment"                     transfer, in
 *       "Thanks for your payment of $7.89" / "Posted date: …". It never
 *       names the paying account, so decide() leaves that side to the bank's
 *       own email, a hand-logged transfer, or "Which account?".
 *
 * Scheduled and AutoPay reminders are ignored (no money has moved yet);
 * statements, CreditWise and offers too. Any other alert with an amount is
 * `unparsed` until a real sample exists — never a guess.
 *
 * A payment TO the card is `transfer`, never `refund` (plan §5.3).
 */

const AMOUNT = String.raw`\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)`;

/** One line of text, so a sentence wrapped across lines still matches. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function cardLast4(text: string): string | null {
  return /\bcard ending in\s+(\d{4})\b/i.exec(text)?.[1] ?? findLast4(text);
}

function parsePurchase(text: string): ParseResult {
  const line = flat(text);
  const m = new RegExp(
    String.raw`notifying you that on (.{6,30}?), at (.+?), a pending authorization or purchase in the amount of ${AMOUNT}`,
    "i",
  ).exec(line);
  if (!m) return { unparsed: "capitalone_purchase_unrecognized" };
  const amountCents = moneyToCents(m[3]);
  const merchantRaw = cleanName(m[2]);
  const last4 = cardLast4(text);
  if (!amountCents) return { unparsed: "no_amount" };
  if (!merchantRaw) return { unparsed: "no_merchant" };
  if (!last4) return { unparsed: "no_last4" };
  return {
    kind: "purchase",
    amountCents,
    merchantRaw,
    accountHint: { last4 },
    occurredAt: null,
    occurredDate: findDate(m[1]),
    // Capital One says so itself: "a pending authorization or purchase".
    isPending: true,
  };
}

function parsePaymentReceived(text: string): ParseResult {
  const line = flat(text);
  const amountCents =
    moneyToCents(new RegExp(String.raw`thanks for your payment of ${AMOUNT}`, "i").exec(line)?.[1]) ??
    moneyToCents(new RegExp(String.raw`payment amount:? ${AMOUNT}`, "i").exec(line)?.[1]);
  const last4 = cardLast4(text);
  if (!amountCents) return { unparsed: "capitalone_payment_no_amount" };
  if (!last4) return { unparsed: "no_last4" };
  const posted = /posted date:?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i.exec(line)?.[1];
  return {
    kind: "transfer",
    transferDirection: "in",
    amountCents,
    merchantRaw: "Capital One payment",
    accountHint: { last4 },
    occurredAt: null,
    occurredDate: posted ? findDate(posted) : null,
    isPending: false,
  };
}

export function parseCapitalOne(email: NormalizedEmail): ParseResult {
  const subject = email.subject.trim();
  // A plain-text rendering shows bold labels as "*Posted date:*".
  const text = stripEmphasis(email.text);
  const all = `${subject}\n${text}`;

  // Alerts come from notification.capitalone.com; offers and rewards news
  // from email. / offer. / communication.capitalone.com.
  if (!/@notification\.capitalone\.com$/i.test(email.from)) return { ignore: "capitalone_marketing" };
  if (/\bdeclined\b/i.test(all)) return { ignore: "declined", kind: "declined" };

  if (/\bpayment\b.*\bis scheduled\b/i.test(subject) || /\bautopay\b.*\bscheduled\b/i.test(subject)) {
    return { ignore: "capitalone_payment_scheduled" };
  }
  if (/received your payment/i.test(subject) || /thanks for your payment of/i.test(text)) {
    return parsePaymentReceived(text);
  }
  if (/transaction was charged/i.test(subject) || /a purchase was charged to your account/i.test(text)) {
    return parsePurchase(text);
  }

  if (/\bstatement\b/i.test(subject)) return { ignore: "capitalone_statement" };
  if (!/\$\s?\d/.test(all)) return { ignore: "capitalone_notice" };
  return { unparsed: "capitalone_unrecognized" };
}

export const capitalOneParser: Parser = {
  id: "capitalone",
  label: "Capital One / Discover",
  version: 2,
  senders: [/@(?:[a-z0-9-]+\.)*capitalone\.com$/i],
  dkimDomains: ["capitalone.com"],
  accountKey: "last4",
  parse: parseCapitalOne,
};
