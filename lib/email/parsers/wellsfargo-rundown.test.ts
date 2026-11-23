import { describe, expect, it } from "vitest";
import { normalizeEmail } from "@/lib/email/normalize";
import { merchantKey } from "@/lib/email/merchantKey";
import { parseWellsFargo } from "@/lib/email/parsers/wellsfargo";
import type { ParsedAlert } from "@/lib/email/types";

/**
 * Wells Fargo "Here's the rundown" lines (parser v5). Each description is a
 * made-up line in the exact shape of a real WF checking / savings statement
 * line; the real ones were checked locally and never committed.
 */
function rundown(direction: "Deposits" | "Withdrawals", description: string, asOf = "11/17/2026"): ParsedAlert {
  const email = normalizeEmail({
    gmailMessageId: "rundown-test",
    from: "Wells Fargo <alerts@notify.wellsfargo.com>",
    to: "stash.inbox@example.com",
    subject: "Your account update is here",
    date: "2026-11-18T09:26:21Z",
    plainBody: [
      "Here's the rundown",
      "for account ...1111",
      direction,
      description,
      "$12.34",
      `As of ${asOf} at 02:48 a.m., Central Time`,
    ].join("\n"),
    htmlBody: "",
    rfc822MessageId: null,
    truncated: false,
    headers: { deliveredTo: null, xForwardedFor: null, xForwardedTo: null, authenticationResults: null },
  } as Parameters<typeof normalizeEmail>[0]);
  return parseWellsFargo(email) as ParsedAlert;
}

describe("WF rundown lines (v5)", () => {
  it("a debit card line is named by its merchant and dated by its authorization", () => {
    const desc = "RECURRING PAYMENT AUTHORIZED ON 11/14 EXAMPLE* STREAM EXAMPLE.COM CA S123456789012345 CARD 1234";
    const a = rundown("Withdrawals", desc);
    // "*" is stripped with the rest of the email's emphasis marks; the key is unchanged.
    expect(a).toMatchObject({ kind: "posted", merchantRaw: "EXAMPLE STREAM EXAMPLE.COM CA", occurredDate: "2026-11-14" });
    // The same merchant key the full line gives: no rule is orphaned.
    expect(merchantKey(a.merchantRaw)).toBe(merchantKey(desc.replace(/ S\d+ CARD \d+$/, "")));
  });

  it("a card line from late December, posted in January, keeps last year", () => {
    const a = rundown("Withdrawals", "PURCHASE AUTHORIZED ON 12/30 EXAMPLE SHOP #12 CITY ST P000000123456789 CARD 1234", "01/02/2027");
    expect(a).toMatchObject({ merchantRaw: "EXAMPLE SHOP #12 CITY ST", occurredDate: "2026-12-30" });
  });

  it("a Bill Pay line is named by its payee, not 'BILL PAY … ON 11-15'", () => {
    const a = rundown("Withdrawals", "BILL PAY Example Rentals Ltd. ON-LINE No Account Number ON 11-15");
    expect(a).toMatchObject({ kind: "posted", merchantRaw: "Example Rentals Ltd", occurredDate: "2026-11-15" });
  });

  it("drops a leading company number, so a payroll rule still applies", () => {
    const a = rundown("Deposits", "123456 EXAMPLE CO PAYROLL 261113 1234 PAT Q PUBLIC");
    expect(a).toMatchObject({ kind: "payment_received", merchantRaw: "EXAMPLE CO PAYROLL", occurredDate: "2026-11-13" });
  });

  it("CRCARDPMT is a card payment, not an expense", () => {
    const a = rundown("Withdrawals", "CAPITAL ONE CRCARDPMT CA0123456789ABC Pat Q Public");
    expect(a).toMatchObject({ kind: "transfer", transferDirection: "out" });
  });

  it("a brokerage ACH is a transfer either way, its other side left to ask", () => {
    const out = rundown("Withdrawals", "FID BKG SVC LLC MONEYLINE 261113 Z12345678 AB12C PAT Q PUBLIC");
    expect(out).toMatchObject({ kind: "transfer", transferDirection: "out" });
    expect(out.fundingSource).toBeUndefined();
    const into = rundown("Deposits", "FID BKG SVC LLC ACH 261113 Z12345678 CD34E PAT Q PUBLIC");
    expect(into).toMatchObject({ kind: "transfer", transferDirection: "in" });
    expect(into.externalFrom).toBeUndefined();
  });

  it("an ACH date written MMDDYY is read that way, never as a year long ago", () => {
    expect(rundown("Withdrawals", "Example Vision Inc WEB PMTS 111326 0AB123 Pat Public").occurredDate).toBe("2026-11-13");
    // Neither reading is near the as-of date: the as-of date, not a guess.
    expect(rundown("Withdrawals", "Example Vision Inc WEB PMTS 080426 0AB123 Pat Public").occurredDate).toBe("2026-11-17");
  });

  it("Zelle from a person: a transfer from Other, carrying the name", () => {
    const a = rundown("Deposits", "ZELLE FROM PUBLIC PAT ON 11/16 REF # WFCT0ABCDEFG");
    expect(a).toMatchObject({
      kind: "transfer",
      transferDirection: "in",
      externalFrom: "Other",
      counterparty: "PUBLIC PAT",
      merchantRaw: "Zelle from PUBLIC PAT",
      occurredDate: "2026-11-16",
    });
  });

  it("Zelle to a person: an expense, carrying the name", () => {
    const a = rundown("Withdrawals", "ZELLE TO DOE JANE ON 11/16 REF #RP0ABCDEFG");
    expect(a).toMatchObject({ kind: "posted", counterparty: "DOE JANE", merchantRaw: "Zelle to DOE JANE" });
  });

  it("a Zelle line under the wrong heading is unparsed, never guessed", () => {
    expect(rundown("Withdrawals", "ZELLE FROM PUBLIC PAT ON 11/16 REF # WFCT0ABCDEFG")).toMatchObject({
      unparsed: "wellsfargo_zelle_direction_mismatch",
    });
  });
});
