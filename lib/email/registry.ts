import type { NormalizedEmail, Parser } from "@/lib/email/types";
import { capitalOneParser } from "@/lib/email/parsers/capitalone";
import { venmoParser } from "@/lib/email/parsers/venmo";
import { wellsFargoParser } from "@/lib/email/parsers/wellsfargo";

/**
 * Every parser Stash knows. Pure.
 *
 * Bank parsers are added ONE AT A TIME from real alerts (plan §5.3): Phase 1
 * stores every email as `unparsed` (`no_parser`), which is how samples are
 * collected. To add a bank:
 *
 *   1. node scripts/export-email-fixture.mjs <gmail_message_id> — scrubs a
 *      real alert into lib/email/parsers/__fixtures__/<bank>/<case>.json
 *   2. copy lib/email/parsers/_template.ts to <bank>.ts and fill it in until
 *      `npm test` passes every fixture (include a payment AND a refund for
 *      card issuers — a misread card payment would invent Income under D1)
 *   3. register it below, then Settings → Email sync → Re-read
 *
 * New parsers always start in shadow mode, because the mode is per scope and
 * live mode is switched on by a person after checking the shadow report.
 */
export const PARSERS: Parser[] = [venmoParser, wellsFargoParser, capitalOneParser];

export function parserById(id: string | null | undefined): Parser | null {
  if (!id) return null;
  return PARSERS.find((p) => p.id === id) ?? null;
}

export function parserForSender(email: NormalizedEmail): Parser | null {
  return PARSERS.find((p) => p.senders.some((re) => re.test(email.from))) ?? null;
}

/** For the account editor's "Alerts from" picker. */
export function parserOptions(): Array<{
  id: string;
  label: string;
  accountKey: Parser["accountKey"];
  /** "Bill Pay" — alerts that name no account, routed by a checkbox. */
  unnumberedLabel: string | null;
}> {
  return PARSERS.map((p) => ({
    id: p.id,
    label: p.label,
    accountKey: p.accountKey,
    unnumberedLabel: p.unnumbered?.label ?? null,
  }));
}
