/**
 * merchantKey — the normalized identity of a merchant string. Pure and
 * browser-safe (Reconcile calls it client-side), so no `node:crypto`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS A NEAR-FROZEN FUNCTION. `merchant_aliases` is keyed by its output,
 * so changing what it returns for an existing string makes every known
 * merchant look brand new and re-asks everything. Any change must:
 *   1. bump MERCHANT_KEY_VERSION, and
 *   2. ship scripts/rekey-merchant-aliases.mjs (recompute from
 *      merchant_aliases.example_raw + email_events.parsed->>'merchantRaw')
 *      IN THE SAME COMMIT.
 * It is deliberately separate from cleanBankDescription and
 * generateMerchantFingerprint, which are frozen for reconciliation hashing.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * All the fuzziness lives here, in one tested function, so aliases can store
 * exact keys (plan C8).
 */
export const MERCHANT_KEY_VERSION = 1;

/** Processor / channel prefixes that say how you paid, not whom. */
const PREFIXES: RegExp[] = [
  /^(?:DEBIT|CREDIT)\s+CARD\s+(?:PURCHASE|PAYMENT|AUTH(?:ORIZATION)?)\s*[-:]?\s*/,
  /^PURCHASE\s+AUTHORIZED\s+ON\s+\d{1,2}\/\d{1,2}\s*/,
  /^RECURRING\s+PAYMENT\s+AUTHORIZED\s+ON\s+\d{1,2}\/\d{1,2}\s*/,
  /^POS\s+(?:PURCHASE\s+|DEBIT\s+)?/,
  /^CHECKCARD\s+\d{4}\s*/,
  /^CHECK\s*CARD\s+/,
  /^SQ\s*\*\s*/,
  /^TST\s*\*\s*/,
  /^PAYPAL\s*\*\s*/,
  /^PP\s*\*\s*/,
  /^SP\s*\*\s*/,
  /^SP\s+(?=\S)/,
  /^DD\s*\*\s*(?=DOORDASH)/,
  /^IC\s*\*\s*/,
  /^EB\s*\*\s*/,
  /^GOOGLE\s*\*\s*/,
  /^APPLE\s*PAY\s+/,
  /^PY\s*\*\s*/,
  /^CKE\s*\*\s*/,
  /^TOAST\s*\*\s*/,
  /^CLOVER\s*\*\s*/,
];

const US_STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM " +
    "NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC"
  ).split(" "),
);

export function merchantKey(raw: string | null | undefined): string {
  const original = String(raw ?? "").trim();
  if (!original) return "";

  // 1. Uppercase, fold apostrophes (MCDONALD'S → MCDONALDS).
  let s = original.toUpperCase().replace(/[’'`´]/g, "");

  // 2. Processor prefixes (repeat: "POS SQ *JOES").
  for (let pass = 0; pass < 3; pass += 1) {
    const before = s;
    for (const re of PREFIXES) s = s.replace(re, "");
    s = s.trimStart();
    if (s === before) break;
  }

  // A run of 2+ spaces in a card descriptor separates name from location
  // ("TARGET 00012345   PROVO   UT"). Keep only what precedes the first run.
  const gap = /\S\s{2,}\S/.exec(s);
  if (gap) s = s.slice(0, gap.index + 1);

  // 3. URL noise and order codes: AMAZON.COM*AB12C → AMAZON, WWW.X.COM → X.
  s = s.replace(/\bWWW\./g, "");
  s = s.replace(/\.(?:COM|NET|ORG|IO|CO)\b/g, " ");
  s = s.replace(/\*\s*[A-Z0-9]*\d[A-Z0-9]*/g, " "); // *AB12C (codes contain a digit)
  s = s.replace(/\*/g, " ");

  //    Phone numbers.
  s = s.replace(/\b1?[-. ]?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, " ");
  s = s.replace(/\b\d{3}-\d{4}\b/g, " ");

  //    Store numbers: "#4127", "NO. 12", and a standalone run of 3+ digits.
  //    Anything after a store number is location, so cut there.
  const storeNo = /(?:#\s*\d+|\bNO\.?\s*\d+|\s[A-Z]{0,2}\d{3,}\b)/.exec(s);
  if (storeNo && storeNo.index > 0) s = s.slice(0, storeNo.index);

  //    Punctuation (keep & and letters/digits).
  s = s.replace(/[^A-Z0-9& ]+/g, " ");

  // 4. Trailing "CITY ST" — only the state code is reliably detectable, so
  //    drop a trailing US state code when something precedes it.
  s = s.replace(/\s+/g, " ").trim();
  const words = s.split(" ");
  if (words.length >= 2 && US_STATES.has(words[words.length - 1])) words.pop();
  s = words.join(" ");

  // 5. Collapse whitespace. A trailing bare number left over is noise too.
  s = s.replace(/\s+\d+$/, "").replace(/\s+/g, " ").trim();

  return s || original.toUpperCase().replace(/\s+/g, " ").trim();
}

/** "MCDONALDS" → "Mcdonalds"; used only as the default display name. */
export function displayNameFromRaw(raw: string): string {
  const key = merchantKey(raw);
  const source = key || raw.trim();
  return source
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length <= 2 && w !== "&" ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .trim();
}

/** Bank/card alerts whose merchant is Venmo are a Venmo leg, never a purchase (D4). */
export function isVenmoKey(key: string): boolean {
  return key === "VENMO" || key.startsWith("VENMO ");
}
