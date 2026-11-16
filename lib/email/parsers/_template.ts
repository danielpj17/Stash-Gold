import type { NormalizedEmail, ParseResult, Parser } from "@/lib/email/types";
import { cleanName, findDate, findLast4, moneyToCents, valueAfterLabel } from "@/lib/email/parsers/util";

/**
 * TEMPLATE — not registered. Copy to `<bank>.ts`, rename, and fill in against
 * real fixtures exported with scripts/export-email-fixture.mjs.
 *
 * Rules every bank parser follows (plan §5.3):
 *   - Never guess. No amount, merchant or last 4 → `{ unparsed: "<why>" }`.
 *   - Declined alerts → `{ ignore: "declined", kind: "declined" }`.
 *   - A payment TO a credit card is `transfer`, NEVER `refund`: under D1 a
 *     refund becomes Income, so a misread card payment would invent income.
 *     Fixtures must cover both for every card parser.
 *   - Authorization ("a charge was made") alerts set `isPending: true`; a
 *     "transaction posted" alert is kind `posted` with `isPending: false`.
 *   - Extract the last 4 and nothing else from a card number.
 *   - Newsletters / offers from the same sender → `{ ignore: "marketing" }`.
 */
export function parseExampleBank(email: NormalizedEmail): ParseResult {
  const text = `${email.subject}\n${email.text}`;

  if (/declined/i.test(text)) return { ignore: "declined", kind: "declined" };

  const amountCents = moneyToCents(valueAfterLabel(text, /^amount\b/i));
  const merchantRaw = valueAfterLabel(text, /^merchant\b/i);
  const last4 = findLast4(text);
  if (!amountCents) return { unparsed: "no_amount" };
  if (!merchantRaw) return { unparsed: "no_merchant" };
  if (!last4) return { unparsed: "no_last4" };

  return {
    kind: "purchase",
    amountCents,
    merchantRaw: cleanName(merchantRaw),
    accountHint: { last4 },
    occurredAt: null,
    occurredDate: findDate(text, new Date(email.receivedAt).getUTCFullYear()),
    isPending: true,
  };
}

export const exampleBankParser: Parser = {
  id: "example_bank",
  label: "Example Bank",
  version: 1,
  senders: [/@alerts\.examplebank\.com$/i],
  dkimDomains: ["examplebank.com"],
  accountKey: "last4",
  parse: parseExampleBank,
};
