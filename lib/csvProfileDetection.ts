/**
 * Guess how to read a bank CSV.
 *
 * This is a *suggestion* that the user confirms in the mapping UI — never
 * applied silently. A wrong guess would produce plausible-but-wrong transaction
 * hashes, which are expensive to unwind once claims reference them.
 *
 * Pure and browser-safe (no node:crypto), so the mapping UI can preview live.
 */

export type DetectedProfile = {
  hasHeader: boolean;
  headerRowIndex: number;
  dateIndex: number | null;
  amountIndex: number | null;
  descriptionIndex: number | null;
  debitIndex: number | null;
  creditIndex: number | null;
  outflowIsPositive: boolean;
  deriveDateFromDescription: boolean;
  /** Header cells as found, for display in the mapping UI. */
  sampleHeaders: string[];
  /** True when every required role was resolved. */
  isComplete: boolean;
};

const HEADER_PATTERNS: Record<"date" | "amount" | "description" | "debit" | "credit", string[]> = {
  // Longest/most specific first — "transaction date" must win over "date".
  date: [
    "transaction date",
    "posting date",
    "post date",
    "posted date",
    "effective date",
    "trans date",
    "date time",
    "datetime",
    "date",
    "posted",
  ],
  amount: ["amount total", "total amount", "transaction amount", "amount", "value"],
  description: [
    "description",
    "payee",
    "merchant",
    "merchant name",
    "name",
    "memo",
    "note",
    "details",
    "transaction",
    "original description",
  ],
  debit: ["debit", "withdrawal", "withdrawals", "charge", "charges", "money out"],
  credit: ["credit", "deposit", "deposits", "payment", "payments", "money in"],
};

function normalizeCell(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/﻿/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findHeaderIndex(normalized: string[], patterns: string[]): number {
  for (const pattern of patterns) {
    const exact = normalized.indexOf(pattern);
    if (exact >= 0) return exact;
  }
  // Fall back to substring so "Posting Date (MM/DD)" still resolves.
  for (const pattern of patterns) {
    const partial = normalized.findIndex((cell) => cell.includes(pattern));
    if (partial >= 0) return partial;
  }
  return -1;
}

/** Accepts the common bank date shapes; deliberately stricter than `new Date()`. */
function looksLikeDate(value: string): boolean {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 32) return false;
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(raw)) return true;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(raw)) return true;
  if (/^\d{1,2}\s+[a-z]{3,}\s+\d{2,4}$/i.test(raw)) return true;
  if (/^[a-z]{3,}\s+\d{1,2},?\s+\d{2,4}$/i.test(raw)) return true;
  return false;
}

function looksLikeAmount(value: string): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  if (!/[\d]/.test(raw)) return false;
  const normalized = raw.replace(/[,$\s()]/g, "");
  if (!/^-?\d*\.?\d+$/.test(normalized)) return false;
  return Number.isFinite(Number(normalized));
}

function parseAmount(value: string): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const isParenNegative = /^\(.*\)$/.test(raw);
  const normalized = raw.replace(/[,$\s()]/g, "");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return isParenNegative ? -Math.abs(n) : n;
}

function columnCount(rows: string[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

/** Share of non-empty cells in a column that satisfy `predicate`. */
function columnScore(
  rows: string[][],
  index: number,
  predicate: (value: string) => boolean,
): number {
  let filled = 0;
  let hits = 0;
  for (const row of rows) {
    const cell = String(row[index] ?? "").trim();
    if (!cell) continue;
    filled += 1;
    if (predicate(cell)) hits += 1;
  }
  return filled === 0 ? 0 : hits / filled;
}

function averageTextLength(rows: string[][], index: number): number {
  let total = 0;
  let count = 0;
  for (const row of rows) {
    const cell = String(row[index] ?? "").trim();
    if (!cell) continue;
    // Letters only, so an amount or date column never wins "most texty".
    total += cell.replace(/[^a-z]/gi, "").length;
    count += 1;
  }
  return count === 0 ? 0 : total / count;
}

export function detectCsvProfile(rows: string[][]): DetectedProfile {
  const clean = (rows ?? []).filter((row) => Array.isArray(row) && row.some((c) => String(c ?? "").trim()));

  const empty: DetectedProfile = {
    hasHeader: false,
    headerRowIndex: 0,
    dateIndex: null,
    amountIndex: null,
    descriptionIndex: null,
    debitIndex: null,
    creditIndex: null,
    outflowIsPositive: false,
    deriveDateFromDescription: false,
    sampleHeaders: [],
    isComplete: false,
  };
  if (clean.length === 0) return empty;

  // --- Pass 1: header names ------------------------------------------------
  // Scan the first few rows, not just the first: exports often start with a
  // title or blank line before the real header.
  let headerRowIndex = -1;
  let dateIndex = -1;
  let amountIndex = -1;
  let descriptionIndex = -1;
  let debitIndex = -1;
  let creditIndex = -1;

  for (let i = 0; i < Math.min(clean.length, 5); i += 1) {
    const normalized = (clean[i] ?? []).map(normalizeCell);
    const d = findHeaderIndex(normalized, HEADER_PATTERNS.date);
    const desc = findHeaderIndex(normalized, HEADER_PATTERNS.description);
    const amt = findHeaderIndex(normalized, HEADER_PATTERNS.amount);
    const deb = findHeaderIndex(normalized, HEADER_PATTERNS.debit);
    const cred = findHeaderIndex(normalized, HEADER_PATTERNS.credit);

    const hasAmountish = amt >= 0 || (deb >= 0 && cred >= 0);
    if (d >= 0 && desc >= 0 && hasAmountish) {
      headerRowIndex = i;
      dateIndex = d;
      descriptionIndex = desc;
      // A separate debit/credit pair takes precedence over a lone amount column.
      if (deb >= 0 && cred >= 0) {
        debitIndex = deb;
        creditIndex = cred;
        amountIndex = -1;
      } else {
        amountIndex = amt;
      }
      break;
    }
  }

  const hasHeader = headerRowIndex >= 0;
  const dataRows = hasHeader ? clean.slice(headerRowIndex + 1) : clean;
  const sample = dataRows.slice(0, 25);

  // --- Pass 2: value shapes (no usable header, or header was ambiguous) -----
  if (!hasHeader && sample.length > 0) {
    const cols = columnCount(sample);
    let bestDate = -1;
    let bestDateScore = 0;
    for (let c = 0; c < cols; c += 1) {
      const score = columnScore(sample, c, looksLikeDate);
      if (score > bestDateScore && score >= 0.8) {
        bestDateScore = score;
        bestDate = c;
      }
    }

    let bestAmount = -1;
    let bestAmountScore = 0;
    for (let c = 0; c < cols; c += 1) {
      if (c === bestDate) continue;
      const score = columnScore(sample, c, looksLikeAmount);
      if (score > bestAmountScore && score >= 0.8) {
        bestAmountScore = score;
        bestAmount = c;
      }
    }

    let bestDesc = -1;
    let bestDescLength = 0;
    for (let c = 0; c < cols; c += 1) {
      if (c === bestDate || c === bestAmount) continue;
      const len = averageTextLength(sample, c);
      if (len > bestDescLength && len >= 3) {
        bestDescLength = len;
        bestDesc = c;
      }
    }

    dateIndex = bestDate;
    amountIndex = bestAmount;
    descriptionIndex = bestDesc;
  }

  // --- Sign convention -----------------------------------------------------
  // Separate debit/credit columns always parse a charge as positive.
  // A single amount column that is mostly positive is a credit-card-style
  // export where charges are positive too.
  let outflowIsPositive = debitIndex >= 0 && creditIndex >= 0;
  if (!outflowIsPositive && amountIndex >= 0 && sample.length > 0) {
    let negatives = 0;
    let positives = 0;
    for (const row of sample) {
      const parsed = parseAmount(String(row[amountIndex] ?? ""));
      if (parsed === null || parsed === 0) continue;
      if (parsed < 0) negatives += 1;
      else positives += 1;
    }
    const total = negatives + positives;
    // Only claim inverted when the evidence is strong and there is enough of it.
    if (total >= 4 && positives / total >= 0.8) outflowIsPositive = true;
  }

  // --- "PURCHASE AUTHORIZED ON MM/DD" embedded dates ------------------------
  let deriveDateFromDescription = false;
  if (descriptionIndex >= 0 && sample.length > 0) {
    let withEmbedded = 0;
    let counted = 0;
    for (const row of sample) {
      const cell = String(row[descriptionIndex] ?? "").trim();
      if (!cell) continue;
      counted += 1;
      if (/purchase\s+authorized\s+on\s+\d{1,2}\/\d{1,2}/i.test(cell)) withEmbedded += 1;
    }
    if (counted > 0 && withEmbedded / counted >= 0.3) deriveDateFromDescription = true;
  }

  const isComplete =
    dateIndex >= 0 &&
    descriptionIndex >= 0 &&
    (amountIndex >= 0 || (debitIndex >= 0 && creditIndex >= 0));

  return {
    hasHeader,
    headerRowIndex: hasHeader ? headerRowIndex : 0,
    dateIndex: dateIndex >= 0 ? dateIndex : null,
    amountIndex: amountIndex >= 0 ? amountIndex : null,
    descriptionIndex: descriptionIndex >= 0 ? descriptionIndex : null,
    debitIndex: debitIndex >= 0 ? debitIndex : null,
    creditIndex: creditIndex >= 0 ? creditIndex : null,
    outflowIsPositive,
    deriveDateFromDescription,
    sampleHeaders: hasHeader ? (clean[headerRowIndex] ?? []).map((c) => String(c ?? "")) : [],
    isComplete,
  };
}
