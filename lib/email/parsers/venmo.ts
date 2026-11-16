import type { AccountHint, NormalizedEmail, ParseResult, Parser } from "@/lib/email/types";
import { cleanName, findDate, findLast4, moneyToCents, valueAfterLabel } from "@/lib/email/parsers/util";

/**
 * Venmo receipts.
 *
 * Version 1 was written from Venmo's published subject formats before any real
 * mail existed. Version 2 (2026-11-16) is corrected against real receipts —
 * see the `real-*` fixtures:
 *   - The note sits between the amount block ("$" / "2" / ".00") and the
 *     "See transaction" button, with no "Note:" label. v1 looked for a line
 *     starting "Note|Memo|For" and matched the footer ("For any issues…").
 *   - Money received arrives as "Jane Doe paid $2.00 to your Venmo account.
 *     Leave it in Venmo or transfer it to your bank account." — v1 saw
 *     "transfer" and booked it as a cash-out.
 *
 * Venmo alerts carry no card number, so the Venmo account is identified by
 * whose inbox forwarded the receipt (`accountKey: "forwarded_from"`).
 *
 * Classification (plan §5.3, §5.12):
 *   "You paid X $20"            payment_sent      → expense on Venmo
 *   "X paid you $20"            payment_received  → Income (D1)
 *   "X completed your request"  payment_received
 *   "X requested $20"           ignored           (a request is not money)
 *   bank transfer / cash out    transfer (out)    → Venmo → bank (D4)
 *   money added from bank       transfer (in)     → bank → Venmo (D4)
 *   declined / failed           ignored (declined)
 * The internal-counterparty rule (D6) needs settings, so it lives in decide().
 */

const AMOUNT = String.raw`\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)`;

function fundingSourceFrom(text: string): AccountHint | "balance" | undefined {
  const value =
    valueAfterLabel(text, /\b(?:payment method|funding source|paid with|source)\b/i) ??
    valueAfterLabel(text, /\btransfer(?:red)? from\b/i);
  if (!value) return undefined;
  if (/venmo balance/i.test(value)) return "balance";
  const last4 = findLast4(value) ?? /(\d{4})\s*$/.exec(value)?.[1];
  const name = cleanName(value.replace(/[*•x.…]+\s?\d{4}.*$/i, ""));
  if (!last4 && !name) return undefined;
  return { ...(last4 ? { last4 } : {}), ...(name ? { name } : {}) };
}

/**
 * The note the sender typed. Real receipts put it, unlabelled, between the
 * amount block and "See transaction":
 *
 *   You paid Jane Doe / $ / 2 / .00 / <note> / See transaction / …
 *
 * Older or other layouts may label it "Note:" / "Memo:". Never a bare "For" —
 * the footer starts "For any issues, …".
 */
function memoFrom(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const see = lines.findIndex((l) => /^see transaction$/i.test(l));
  if (see > 0) {
    // Start after the cents line (".00"), else after the last amount-only line.
    let start = -1;
    for (let i = see - 1; i >= 0; i -= 1) {
      if (/^\.\d{2}$/.test(lines[i]) || /^\$\s?[\d,]+(?:\.\d{2})?$/.test(lines[i])) {
        start = i + 1;
        break;
      }
    }
    if (start > 0) {
      const note = lines.slice(start, see).join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
      return note || undefined;
    }
  }
  const labelled = valueAfterLabel(text, /^\s*(?:note|memo)\b/i);
  if (labelled) return labelled.replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
  return undefined;
}

export function parseVenmo(email: NormalizedEmail): ParseResult {
  const subject = email.subject;
  const text = email.text;
  const date = findDate(text, new Date(email.receivedAt).getUTCFullYear());
  const base = {
    accountHint: {},
    occurredAt: null,
    occurredDate: date,
    isPending: false,
  };

  if (/\b(declined|failed|couldn'?t be completed|was not completed|unsuccessful)\b/i.test(subject)) {
    return { ignore: "declined", kind: "declined" };
  }
  if (/\brequest(?:ed|s)?\b/i.test(subject) && !/\b(paid|completed)\b/i.test(subject)) {
    return { ignore: "venmo_request" };
  }
  if (/\b(reminder|security|verify|password|sign[- ]?in|log[- ]?in|statement|privacy|terms)\b/i.test(subject)) {
    return { ignore: "venmo_notice" };
  }

  // "You paid Jane Doe $25.00" / "You paid Jane Doe's $25.00 request"
  let m = new RegExp(String.raw`^you paid (.+?)(?:'s)?\s+${AMOUNT}`, "i").exec(subject);
  if (m) {
    const amountCents = moneyToCents(m[2]);
    const counterparty = cleanName(m[1]);
    if (!amountCents || !counterparty) return { unparsed: "venmo_payment_sent_unreadable" };
    return {
      ...base,
      kind: "payment_sent",
      amountCents,
      merchantRaw: counterparty,
      counterparty,
      memo: memoFrom(text),
      fundingSource: fundingSourceFrom(text),
    };
  }

  // "Jane Doe paid you $25.00" / "Jane Doe completed your $25.00 request" /
  // "Jane Doe paid $25.00 to your Venmo account. Leave it in Venmo or transfer
  // it to your bank account." (the real 2026 subject — must win over the
  // transfer branch below, which would see "transfer").
  m =
    new RegExp(String.raw`^(.+?) (?:paid you|completed your)\s+${AMOUNT}`, "i").exec(subject) ??
    new RegExp(String.raw`^(.+?) paid\s+${AMOUNT}\s+to your venmo\b`, "i").exec(subject);
  if (m) {
    const amountCents = moneyToCents(m[2]);
    const counterparty = cleanName(m[1]);
    if (!amountCents || !counterparty) return { unparsed: "venmo_payment_received_unreadable" };
    return {
      ...base,
      kind: "payment_received",
      amountCents,
      merchantRaw: counterparty,
      counterparty,
      memo: memoFrom(text),
    };
  }

  // Cash-out to a bank: "Your bank transfer has been initiated", "You
  // transferred $100.00 to your bank", "Your Venmo transfer is on its way".
  // Never a subject that says someone PAID — that's a payment that merely
  // mentions transferring it on.
  if (/\btransfer/i.test(subject) && !/\b(add(?:ed)?|from your bank|paid)\b/i.test(subject)) {
    const amountCents = moneyToCents(new RegExp(AMOUNT).exec(subject)?.[0]) ?? moneyToCents(new RegExp(AMOUNT).exec(text)?.[0]);
    if (!amountCents) return { unparsed: "venmo_transfer_no_amount" };
    const destination = valueAfterLabel(text, /\b(?:destination|bank account|transfer(?:red)? to)\b/i);
    const last4 = (destination ? findLast4(destination) : null) ?? findLast4(text);
    return {
      ...base,
      kind: "transfer",
      transferDirection: "out",
      amountCents,
      merchantRaw: "Venmo transfer",
      fundingSource: last4 ? { last4 } : undefined,
    };
  }

  // Money added to Venmo from a bank.
  if (/\b(added|add money)\b/i.test(subject)) {
    const amountCents = moneyToCents(new RegExp(AMOUNT).exec(subject)?.[0]) ?? moneyToCents(new RegExp(AMOUNT).exec(text)?.[0]);
    if (!amountCents) return { unparsed: "venmo_add_money_no_amount" };
    const last4 = findLast4(text);
    return {
      ...base,
      kind: "transfer",
      transferDirection: "in",
      amountCents,
      merchantRaw: "Venmo transfer",
      fundingSource: last4 ? { last4 } : undefined,
    };
  }

  if (!new RegExp(AMOUNT).test(subject)) return { ignore: "venmo_marketing" };
  return { unparsed: "venmo_unrecognised_subject" };
}

export const venmoParser: Parser = {
  id: "venmo",
  label: "Venmo",
  version: 2,
  senders: [/^venmo@venmo\.com$/i, /@(?:[a-z0-9-]+\.)?venmo\.com$/i],
  dkimDomains: ["venmo.com"],
  accountKey: "forwarded_from",
  parse: parseVenmo,
};
