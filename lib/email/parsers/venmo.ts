import type { AccountHint, NormalizedEmail, ParseResult, Parser } from "@/lib/email/types";
import { cleanName, findDate, findLast4, moneyToCents, valueAfterLabel } from "@/lib/email/parsers/util";

/**
 * Venmo receipts.
 *
 * ⚠ Version 1 is written from Venmo's published subject formats, NOT from real
 * samples (none existed when it was written). That is safe only because
 * Phase 2 runs every parser in SHADOW mode first: nothing is written until a
 * week of shadow output has been checked against reality. When real receipts
 * arrive, export them with scripts/export-email-fixture.mjs, add them under
 * __fixtures__/venmo/, fix anything they disagree with, and bump `version`.
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

function memoFrom(text: string): string | undefined {
  const labelled = valueAfterLabel(text, /^\s*(?:note|memo|for)\b/i);
  if (labelled) return cleanName(labelled).slice(0, 200) || undefined;
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

  // "Jane Doe paid you $25.00" / "Jane Doe completed your $25.00 request"
  m = new RegExp(String.raw`^(.+?) (?:paid you|completed your)\s+${AMOUNT}`, "i").exec(subject);
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
  if (/\btransfer/i.test(subject) && !/\b(add(?:ed)?|from your bank)\b/i.test(subject)) {
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
  version: 1,
  senders: [/^venmo@venmo\.com$/i, /@(?:[a-z0-9-]+\.)?venmo\.com$/i],
  dkimDomains: ["venmo.com"],
  accountKey: "forwarded_from",
  parse: parseVenmo,
};
