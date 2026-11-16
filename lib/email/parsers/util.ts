/**
 * Small, strict helpers shared by parsers. Pure.
 *
 * "Strict" is the point: a parser that can't find exactly what it needs must
 * return `unparsed`, never a guess (plan §5.3).
 */

/** "$1,234.56" / "1234.5" / "USD 12.00" → integer cents, or null. Never floats. */
export function moneyToCents(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /(-)?\s*(?:US)?\$?\s*(?:USD\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b/i.exec(raw.trim());
  if (!m) return null;
  const whole = Number(m[2].replace(/,/g, ""));
  if (!Number.isSafeInteger(whole)) return null;
  const frac = m[3] ? Number(m[3].padEnd(2, "0")) : 0;
  const cents = whole * 100 + frac;
  return cents > 0 ? cents : null;
}

/** Every "$12.34" in a text, in order, as cents. */
export function allDollarAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const cents = Number(m[1].replace(/,/g, "")) * 100 + (m[2] ? Number(m[2]) : 0);
    if (cents > 0) out.push(cents);
  }
  return out;
}

/**
 * The card/account's last four digits, from the usual phrasings:
 * "ending in 1234", "ending 1234", "••1234", "****1234", "x1234", "…1234".
 * Returns null when there are zero or conflicting matches.
 */
export function findLast4(text: string): string | null {
  const patterns = [
    /ending\s+(?:in\s+)?(?:\*+|x+|•+)?\s*(\d{4})\b/gi,
    /(?:\*{2,}|•{2,}|x{2,}|\.{3}|…)\s?(\d{4})\b/gi,
    /\b(?:card|account|acct)\s*(?:#|no\.?|number)?\s*[x*•]+\s?(\d{4})\b/gi,
  ];
  const found = new Set<string>();
  for (const re of patterns) {
    for (let m = re.exec(text); m; m = re.exec(text)) found.add(m[1]);
  }
  return found.size === 1 ? [...found][0] : null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A calendar date written in an alert body: "Nov 15, 2026", "November 15,
 * 2026", "11/15/2026", "11/15/26", "2026-11-15". Returns YYYY-MM-DD or null.
 * A bare "11/15" uses `fallbackYear`.
 */
export function findDate(text: string, fallbackYear?: number): string | null {
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(text);
  if (m) return iso(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));

  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(text);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return iso(y, Number(m[1]), Number(m[2]));
  }

  if (fallbackYear) {
    m = /\b(\d{1,2})\/(\d{1,2})\b/.exec(text);
    if (m) return iso(fallbackYear, Number(m[1]), Number(m[2]));
  }
  return null;
}

/** First line matching `label` and the value after it ("Merchant: X", "Merchant\nX"). */
export function valueAfterLabel(text: string, label: RegExp): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = label.exec(line);
    if (!m) continue;
    const rest = line.slice(m.index + m[0].length).replace(/^[\s:–—-]+/, "").trim();
    if (rest) return rest;
    const next = lines[i + 1]?.trim();
    if (next) return next;
  }
  return null;
}

/** Collapse whitespace and strip surrounding punctuation from a captured name. */
export function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/^[\s"'“”‘’:,-]+|[\s"'“”‘’:,.-]+$/g, "").trim();
}
