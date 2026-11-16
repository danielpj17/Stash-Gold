import { describe, expect, it } from "vitest";
import { displayNameFromRaw, isVenmoKey, merchantKey } from "@/lib/email/merchantKey";

/**
 * merchantKey is near-frozen: aliases are keyed by its output. If a change
 * here makes one of these rows fail, that's a MERCHANT_KEY_VERSION bump plus a
 * re-key script in the same commit — not a test update.
 */
const TABLE: Array<[string, string]> = [
  ["MCDONALD'S F12345", "MCDONALDS"],
  ["McDonald’s #4127", "MCDONALDS"],
  ["SQ *JOES PIZZA", "JOES PIZZA"],
  ["TST* CAFE RIO 1234 PROVO UT", "CAFE RIO"],
  ["PAYPAL *NETFLIX", "NETFLIX"],
  ["AMAZON.COM*AB12C", "AMAZON"],
  ["AMZN MKTP US*2K4LM0", "AMZN MKTP US"],
  ["NETFLIX.COM", "NETFLIX"],
  ["MAVERIK #412 OGDEN UT", "MAVERIK"],
  ["CHEVRON 0204513", "CHEVRON"],
  ["SHELL OIL 57444212345", "SHELL OIL"],
  ["SMITHS FOOD #4127 SALT LAKE CTY UT", "SMITHS FOOD"],
  ["HARMONS - CITY CREEK", "HARMONS CITY CREEK"],
  ["UBER *TRIP", "UBER TRIP"],
  ["UBER *EATS", "UBER EATS"],
  ["POS PURCHASE TARGET 00012345   PROVO   UT", "TARGET"],
  ["PURCHASE AUTHORIZED ON 01/02 STARBUCKS STORE 12345", "STARBUCKS STORE"],
  ["VENMO 855-812-4430 NY", "VENMO"],
  ["VENMO* Visa Direct", "VENMO VISA DIRECT"],
  ["Alex Smith", "ALEX SMITH"],
  ["H&M 0123", "H&M"],
  ["7-ELEVEN 12345", "7 ELEVEN"],
  ["  ", ""],
];

describe("merchantKey", () => {
  it.each(TABLE)("%s → %s", (raw, expected) => {
    expect(merchantKey(raw)).toBe(expected);
  });

  it("is idempotent", () => {
    for (const [raw] of TABLE) expect(merchantKey(merchantKey(raw))).toBe(merchantKey(raw));
  });

  it("recognises Venmo legs on card statements", () => {
    expect(isVenmoKey(merchantKey("VENMO 855-812-4430 NY"))).toBe(true);
    expect(isVenmoKey(merchantKey("VENMO* Visa Direct"))).toBe(true);
    expect(isVenmoKey(merchantKey("VENMOUTH CAFE"))).toBe(false);
  });

  it("builds a readable default display name", () => {
    expect(displayNameFromRaw("SQ *JOES PIZZA")).toBe("Joes Pizza");
    expect(displayNameFromRaw("AMAZON.COM*AB12C")).toBe("Amazon");
  });
});
