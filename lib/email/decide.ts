import { EMAIL_SYNC_CONFIG } from "@/lib/email/config";
import { displayNameFromRaw, isVenmoKey } from "@/lib/email/merchantKey";
import { localDate } from "@/lib/email/occurredAt";
import { wholeEmailId } from "@/lib/email/parts";
import { decideCategory, type MerchantRule } from "@/lib/email/rules";
import type { AccountHint, ParsedAlert, ParsedAlertKind } from "@/lib/email/types";

/**
 * decide() — what should this alert do? PURE. (Plan §3 step 8.)
 *
 * It takes the parsed alert plus everything `context.ts` loaded and returns a
 * PLAN. `apply.ts` turns a plan into one atomic `sql.transaction`. Keeping the
 * decision pure is what makes shadow mode ("store the plan, skip apply"), the
 * unit tests of every merge/dedupe rule, and the re-parse dry run possible.
 *
 * Order matters and mirrors the plan:
 *   1. declined → ignored
 *   2. internal counterparty (D6) → ignored
 *   3. Venmo legs (D4) — BEFORE money-in, so a Venmo cash-out is never Income
 *   4. card payments / transfers between your own accounts → a transfer row,
 *      paired across the two banks' emails and with a hand-logged transfer
 *   5. money in (D1) → Income — except a Venmo payment from a person, which
 *      is a transfer from "Other" into that Venmo account
 *   6. purchases → duplicate? follow-up? link a manual entry? else create
 */

export type AccountRef = {
  id: string;
  name: string;
  kind: string;
  isDefault: boolean;
  alertSource: string | null;
  alertLast4: string | null;
  alertForwardedFrom: string | null;
  /** Receives this source's alerts that name no account (Bill Pay, migration 008). */
  alertUnnumbered: boolean;
  unattendedAction: "keep_in_review" | "auto_guess";
};

export type CandidateRow = {
  id: string;
  kind: "expense" | "income" | "transfer";
  occurredAt: string;
  createdAt: string;
  amountCents: number;
  originalAmountCents: number | null;
  category: string | null;
  reviewStatus: "needs_review" | "confirmed";
  source: "manual" | "shortcut" | "email" | "csv";
  account: string | null;
  transferFrom: string | null;
  transferTo: string | null;
  isPending: boolean;
  merchantId: string | null;
  emailEventId: string | null;
  autoMerged: boolean;
  /** Claimed in reconciliation — its amount is fixed (C21). */
  claimed: boolean;
  // From the email event that created/linked this row, when there is one.
  eventGmailMessageId: string | null;
  eventBodySha256: string | null;
  eventForwardedFor: string | null;
  eventKind: ParsedAlertKind | null;
  eventMerchantKey: string | null;
};

export type DecideContext = {
  mode: "shadow" | "live";
  timeZone: string;
  /** Lowercased Venmo names that mean "us" (D6). */
  internalCounterparties: string[];
  parser: { id: string; accountKey: "last4" | "forwarded_from" };
  event: {
    id: string;
    gmailMessageId: string;
    bodySha256: string;
    forwardedFor: string | null;
    receivedAt: string;
  };
  alert: ParsedAlert;
  occurredAt: string;
  merchantKey: string;
  merchant: MerchantRule | null;
  /** The account this alert is about. The pipeline stops at unknown_account first. */
  account: AccountRef;
  /** All live accounts in the scope. */
  accounts: AccountRef[];
  defaultAccountId: string | null;
  /** Rows near `occurredAt` that any rule might pair with. */
  candidates: CandidateRow[];
  config?: Partial<typeof EMAIL_SYNC_CONFIG>;
};

/** Which new row a plan field refers to; apply.ts assigns the real ids. */
export type NewRowRef = "primary" | "venmo_transfer";

export type NewTransaction = {
  ref: NewRowRef;
  kind: "expense" | "income" | "transfer";
  amountCents: number;
  category: string | null;
  description: string;
  account: string | null;
  transferFrom: string | null;
  transferTo: string | null;
  reviewStatus: "needs_review" | "confirmed";
  categorizedBy: "user" | "rule" | "guess" | null;
  isPending: boolean;
  /** Attach the alert's merchant (expenses only). */
  attachMerchant: boolean;
  /** Carry this event's id (the C14 idempotency key). Only the primary row. */
  attachEvent: boolean;
};

export type RowUpdate = {
  id: string;
  account?: string;
  transferFrom?: string;
  transferTo?: string;
  isPending?: boolean;
  reviewStatus?: "confirmed";
  attachEvent?: boolean;
  attachMerchant?: boolean;
};

export type Plan =
  | { action: "ignore"; status: "ignored"; reason: string }
  | { action: "duplicate"; status: "duplicate"; transactionId: string; reason: string }
  | {
      action: "create";
      status: "created";
      reason: string;
      transactions: NewTransaction[];
      updates: RowUpdate[];
      /** Phase 5: push the people subscribed to this account. */
      notify: boolean;
      choices: string[] | "all";
    }
  | { action: "link"; status: "linked"; reason: string; transactionId: string; update: RowUpdate }
  | {
      action: "followup";
      status: "followup";
      reason: string;
      transactionId: string;
      oldAmountCents: number;
      newAmountCents: number;
      changeReason: "posted" | "tip" | "gas_final";
      autoMerged: boolean;
      isPending: boolean;
    }
  | { action: "followup_ignored"; status: "followup_ignored_reconciled"; reason: string; transactionId: string }
  | { action: "ambiguous"; status: "ambiguous"; reason: string; candidateIds: string[] };

// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function cfgOf(ctx: DecideContext) {
  return { ...EMAIL_SYNC_CONFIG, ...(ctx.config ?? {}) };
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function dayDiff(a: string, b: string, timeZone: string): number {
  const da = Date.parse(`${localDate(a, timeZone)}T00:00:00Z`);
  const db = Date.parse(`${localDate(b, timeZone)}T00:00:00Z`);
  return Math.round(Math.abs(da - db) / DAY_MS);
}

function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function ignore(reason: string): Plan {
  return { action: "ignore", status: "ignored", reason };
}

function duplicate(transactionId: string, reason: string): Plan {
  return { action: "duplicate", status: "duplicate", transactionId, reason };
}

export function isGasHold(amountCents: number, cfg = EMAIL_SYNC_CONFIG): boolean {
  if (cfg.gasHoldExactAmounts.some((a) => Math.round(a * 100) === amountCents)) return true;
  const dollars = amountCents / 100;
  const [lo, hi] = cfg.gasHoldRoundRange;
  return amountCents % 2500 === 0 && dollars >= lo && dollars <= hi;
}

/** What a candidate row files as, for the tip/gas rules. */
function filesAs(row: CandidateRow, ctx: DecideContext): string | null {
  if (row.category) return row.category;
  const m = ctx.merchant;
  if (!m) return null;
  return m.mode === "auto" ? m.category : m.defaultCategory;
}

function sameMerchant(row: CandidateRow, ctx: DecideContext): boolean {
  if (ctx.merchant && row.merchantId) return row.merchantId === ctx.merchant.id;
  return row.eventMerchantKey !== null && row.eventMerchantKey === ctx.merchantKey;
}

// ---- 6a. duplicate alerts --------------------------------------------------

/**
 * The same alert seen twice: a Gmail redelivery (identical body) or both
 * spouses' inboxes forwarding the joint card's alert (different forwarder).
 */
export function findDuplicateAlert(
  ctx: DecideContext,
  kind: "expense" | "income",
): CandidateRow | null {
  const cfg = cfgOf(ctx);
  const a = ctx.alert;
  const window = cfg.duplicateAlertWindowMinutes * 60_000;
  const matches = ctx.candidates.filter(
    (c) =>
      c.emailEventId !== null &&
      c.kind === kind &&
      c.account === ctx.account.id &&
      c.eventKind === a.kind &&
      (c.amountCents === a.amountCents || c.originalAmountCents === a.amountCents) &&
      c.eventMerchantKey === ctx.merchantKey &&
      Math.abs(ms(c.occurredAt) - ms(ctx.occurredAt)) <= window &&
      c.eventGmailMessageId !== ctx.event.gmailMessageId &&
      (c.eventBodySha256 === ctx.event.bodySha256 ||
        (c.eventForwardedFor ?? "") !== (ctx.event.forwardedFor ?? "")),
  );
  return matches[0] ?? null;
}

// ---- 6b/6d. follow-ups ----------------------------------------------------

/** Pending email rows this alert could be updating (plan §5.6 "Candidates"). */
export function pendingCandidates(ctx: DecideContext): CandidateRow[] {
  const cfg = cfgOf(ctx);
  const occ = ms(ctx.occurredAt);
  return ctx.candidates.filter(
    (c) =>
      c.kind === "expense" &&
      c.isPending &&
      c.emailEventId !== null &&
      c.emailEventId !== ctx.event.id &&
      c.account === ctx.account.id &&
      sameMerchant(c, ctx) &&
      ms(c.occurredAt) >= occ - cfg.followupWindowDays * DAY_MS &&
      ms(c.occurredAt) <= occ + DAY_MS,
  );
}

function labelFor(
  row: CandidateRow,
  newCents: number,
  ctx: DecideContext,
): "posted" | "tip" | "gas_final" {
  const cfg = cfgOf(ctx);
  const files = filesAs(row, ctx);
  if (files === cfg.gasCategory && isGasHold(row.amountCents, cfg) && !isGasHold(newCents, cfg)) {
    return "gas_final";
  }
  if (
    files !== null &&
    (cfg.tipCategories as readonly string[]).includes(files) &&
    newCents > row.amountCents &&
    newCents <= Math.round(row.amountCents * (1 + cfg.tipMaxIncreasePct / 100))
  ) {
    return "tip";
  }
  return "posted";
}

function explicitFollowup(ctx: DecideContext): Plan | null {
  const a = ctx.alert;
  if (a.kind !== "posted" && a.kind !== "amount_changed") return null;
  const all = pendingCandidates(ctx);
  const open = all.filter((c) => !c.claimed);
  if (open.length === 1) {
    const row = open[0];
    return {
      action: "followup",
      status: "followup",
      reason: row.amountCents === a.amountCents ? "posted_same_amount" : "posted_new_amount",
      transactionId: row.id,
      oldAmountCents: row.amountCents,
      newAmountCents: a.amountCents,
      changeReason: labelFor(row, a.amountCents, ctx),
      autoMerged: false,
      isPending: false,
    };
  }
  if (open.length > 1) {
    // Creating anything would double one of them; a person picks.
    return {
      action: "ambiguous",
      status: "ambiguous",
      reason: "which_purchase_did_this_update",
      candidateIds: open.map((c) => c.id),
    };
  }
  const claimed = all.find((c) => c.claimed);
  if (claimed) {
    return {
      action: "followup_ignored",
      status: "followup_ignored_reconciled",
      reason: "row_already_reconciled",
      transactionId: claimed.id,
    };
  }
  return null; // first sighting: some banks only send posted alerts
}

/** Phase 4: an authorization arriving after the posted row it belongs to. */
function outOfOrder(ctx: DecideContext): Plan | null {
  const cfg = cfgOf(ctx);
  const a = ctx.alert;
  if (!cfg.enableOutOfOrder || a.kind !== "purchase" || !a.isPending) return null;
  const occ = ms(ctx.occurredAt);
  const rows = ctx.candidates.filter(
    (c) =>
      c.kind === "expense" &&
      c.emailEventId !== null &&
      !c.isPending &&
      (c.eventKind === "posted" || c.eventKind === "amount_changed") &&
      c.account === ctx.account.id &&
      sameMerchant(c, ctx) &&
      ms(c.occurredAt) >= occ - DAY_MS &&
      ms(c.occurredAt) <= occ + cfg.followupWindowDays * DAY_MS &&
      (c.amountCents === a.amountCents ||
        labelFor({ ...c, amountCents: a.amountCents }, c.amountCents, ctx) !== "posted"),
  );
  return rows.length === 1 ? duplicate(rows[0].id, "authorization_after_posted") : null;
}

/** Phase 4 / D3: tip and gas-hold merges without a posted alert. */
function heuristicFollowup(ctx: DecideContext): Plan | null {
  const cfg = cfgOf(ctx);
  const a = ctx.alert;
  if (a.kind !== "purchase") return null;
  const open = pendingCandidates(ctx).filter((c) => !c.claimed && ms(c.occurredAt) <= ms(ctx.occurredAt));
  if (open.length !== 1) return null; // exactly one candidate, or a separate purchase
  const row = open[0];
  const files = filesAs(row, ctx);
  const newCents = a.amountCents;

  if (
    cfg.enableGasHoldHeuristic &&
    files === cfg.gasCategory &&
    isGasHold(row.amountCents, cfg) &&
    !isGasHold(newCents, cfg) // C20: a second $1.00 hold is a second fill-up
  ) {
    return {
      action: "followup",
      status: "followup",
      reason: "gas_hold_final",
      transactionId: row.id,
      oldAmountCents: row.amountCents,
      newAmountCents: newCents,
      changeReason: "gas_final",
      autoMerged: true,
      isPending: a.isPending,
    };
  }

  const gapHours = (ms(ctx.occurredAt) - ms(row.occurredAt)) / 3_600_000;
  if (
    cfg.enableTipHeuristic &&
    files !== null &&
    (cfg.tipCategories as readonly string[]).includes(files) &&
    newCents > row.amountCents &&
    newCents <= Math.round(row.amountCents * (1 + cfg.tipMaxIncreasePct / 100)) &&
    gapHours >= cfg.tipMinGapHours
  ) {
    return {
      action: "followup",
      status: "followup",
      reason: "tip_added",
      transactionId: row.id,
      oldAmountCents: row.amountCents,
      newAmountCents: newCents,
      changeReason: "tip",
      autoMerged: true,
      isPending: a.isPending,
    };
  }
  return null;
}

// ---- 6c. manual entries ----------------------------------------------------

/**
 * Could a hand-logged amount be this alert? Equal, or (Phase 4) the manual
 * entry is the final amount of a tipped / held alert.
 */
export function amountsCompatible(
  manualCents: number,
  alertCents: number,
  manualCategory: string | null,
  alertIsPending: boolean,
  cfg = EMAIL_SYNC_CONFIG,
): boolean {
  if (manualCents === alertCents) return true;
  if (!cfg.enableToleranceLinking || !alertIsPending) return false;
  if (manualCategory === cfg.gasCategory && isGasHold(alertCents, cfg)) return true;
  return (
    manualCategory !== null &&
    (cfg.tipCategories as readonly string[]).includes(manualCategory) &&
    manualCents > alertCents &&
    manualCents <= Math.round(alertCents * (1 + cfg.tipMaxIncreasePct / 100))
  );
}

/** C18: the account must match, or the manual row is on the default account. */
export function manualCandidates(ctx: DecideContext, kind: "expense" | "income"): CandidateRow[] {
  const cfg = cfgOf(ctx);
  const a = ctx.alert;
  return ctx.candidates.filter(
    (c) =>
      c.kind === kind &&
      (c.source === "manual" || c.source === "shortcut") &&
      c.emailEventId === null &&
      !c.claimed &&
      (c.account === ctx.account.id || c.account === null || c.account === ctx.defaultAccountId) &&
      dayDiff(c.occurredAt, ctx.occurredAt, ctx.timeZone) <= cfg.manualMatchWindowDays &&
      (kind === "income"
        ? c.amountCents === a.amountCents
        : amountsCompatible(c.amountCents, a.amountCents, c.category, a.isPending, cfg)),
  );
}

function linkManual(ctx: DecideContext, row: CandidateRow, kind: "expense" | "income"): Plan {
  const update: RowUpdate = {
    id: row.id,
    attachEvent: true,
    attachMerchant: kind === "expense",
    isPending: kind === "expense" ? ctx.alert.isPending && ctx.alert.kind === "purchase" : false,
  };
  // The alert knows the real account; a row on the default only got there
  // because New Expense has no account picker. This also fixes balances.
  if (row.account !== ctx.account.id) update.account = ctx.account.id;
  return { action: "link", status: "linked", reason: "matched_manual_entry", transactionId: row.id, update };
}

// ---- descriptions ------------------------------------------------------------

function merchantName(ctx: DecideContext): string {
  return ctx.merchant?.displayName ?? displayNameFromRaw(ctx.alert.merchantRaw);
}

export function describe(ctx: DecideContext, kind: "expense" | "income"): string {
  const a = ctx.alert;
  if (ctx.parser.id === "venmo" && a.counterparty) {
    // The note typed in Venmo IS the description — it's what you'd have logged
    // by hand. Who it was to/from is already the merchant. No note: say who.
    if (a.memo) return a.memo;
    return kind === "income" ? `Venmo from ${a.counterparty}` : `Venmo to ${a.counterparty}`;
  }
  if (kind === "income") {
    // A deposit is called by its SOURCE, the way a purchase is called by its
    // merchant: "Acme", not "Deposit · …" — what you'd type for a
    // paycheck by hand. The source is a merchant row (attached in
    // decideIncome), so it's renamed once under Rules → Money in. A refund
    // keeps its prefix: it shares the name of the store you bought from.
    return a.kind === "refund" ? `Refund · ${merchantName(ctx)}` : merchantName(ctx);
  }
  return merchantName(ctx);
}

// ---- 3. Venmo legs (D4) -------------------------------------------------------

type Leg = {
  from: string | null;
  to: string | null;
  /** Which side is the Venmo account (resolved or not). */
  venmoSide: "from" | "to";
  description: string;
};

function venmoAccounts(ctx: DecideContext): AccountRef[] {
  return ctx.accounts.filter((a) => a.alertSource === "venmo");
}

function accountByLast4(ctx: DecideContext, hint: AccountHint | "balance" | undefined): AccountRef | null {
  if (!hint || hint === "balance" || !hint.last4) return null;
  const hits = ctx.accounts.filter((a) => a.alertLast4 === hint.last4);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Which Venmo account does a bank/card VENMO line belong to? One account:
 * that one. Several: the one whose receipt of the same amount (±1 day)
 * already arrived. Otherwise unknown — "Which Venmo account?" (plan §5.12).
 * No Venmo account at all: the external label "Venmo", so the bank side still
 * moves and nothing waits for an answer that can't come.
 */
function resolveVenmoSide(ctx: DecideContext, direction: "out" | "in"): string | null {
  const cfg = cfgOf(ctx);
  const venmos = venmoAccounts(ctx);
  if (venmos.length === 0) return "Venmo";
  if (venmos.length === 1) return venmos[0].id;
  const ids = new Set(venmos.map((v) => v.id));
  const wantKind: ParsedAlertKind = direction === "out" ? "payment_sent" : "transfer";
  const paired = ctx.candidates.filter(
    (c) =>
      c.emailEventId !== null &&
      c.eventKind === wantKind &&
      c.amountCents === ctx.alert.amountCents &&
      dayDiff(c.occurredAt, ctx.occurredAt, ctx.timeZone) <= cfg.venmoCardMatchWindowDays &&
      ((c.account !== null && ids.has(c.account)) ||
        (c.transferFrom !== null && ids.has(c.transferFrom))),
  );
  const accounts = new Set(paired.map((c) => (c.account && ids.has(c.account) ? c.account : c.transferFrom)));
  return accounts.size === 1 ? ([...accounts][0] as string) : null;
}

/** Is this alert a Venmo leg, and if so which way does the money go? */
export function venmoLeg(ctx: DecideContext): Leg | null {
  const a = ctx.alert;
  const moneyIn = a.kind === "refund" || a.kind === "payment_received";

  // A bank/card alert whose merchant is Venmo: never an expense or income.
  if (ctx.parser.id !== "venmo" && isVenmoKey(ctx.merchantKey)) {
    if (a.kind === "declined") return null;
    return moneyIn
      ? { from: resolveVenmoSide(ctx, "in"), to: ctx.account.id, venmoSide: "from", description: "Venmo cash-out" }
      : { from: ctx.account.id, to: resolveVenmoSide(ctx, "out"), venmoSide: "to", description: "Venmo transfer" };
  }

  // A Venmo email about moving money to or from a bank.
  if (ctx.parser.id === "venmo" && a.kind === "transfer") {
    const bank = accountByLast4(ctx, a.fundingSource)?.id ?? null;
    return a.transferDirection === "in"
      ? { from: bank, to: ctx.account.id, venmoSide: "to", description: "Venmo top-up" }
      : { from: ctx.account.id, to: bank, venmoSide: "from", description: "Venmo cash-out" };
  }
  return null;
}

function sideCompatible(mine: string | null, theirs: string | null): boolean {
  return mine === null || theirs === null || mine === theirs;
}

/**
 * A transfer row this leg duplicates (or completes): within `windowDays` of
 * another email (the Venmo window by default), or the manual window of a
 * hand-logged transfer.
 */
function matchingTransfer(
  ctx: DecideContext,
  leg: { from: string | null; to: string | null },
  windowDays?: number,
): CandidateRow[] {
  const cfg = cfgOf(ctx);
  const emailWindow = windowDays ?? cfg.venmoCardMatchWindowDays;
  return ctx.candidates.filter(
    (c) =>
      c.kind === "transfer" &&
      c.amountCents === ctx.alert.amountCents &&
      dayDiff(c.occurredAt, ctx.occurredAt, ctx.timeZone) <=
        Math.max(emailWindow, c.source === "email" ? 0 : cfg.manualMatchWindowDays) &&
      sideCompatible(leg.from, c.transferFrom) &&
      sideCompatible(leg.to, c.transferTo) &&
      // At least one side must match exactly, or any two transfers of the
      // same amount would pair.
      ((leg.from !== null && leg.from === c.transferFrom) || (leg.to !== null && leg.to === c.transferTo)),
  );
}

function fillUnknownSides(row: CandidateRow, leg: { from: string | null; to: string | null }): RowUpdate | null {
  const update: RowUpdate = { id: row.id };
  if (row.transferFrom === null && leg.from !== null) update.transferFrom = leg.from;
  if (row.transferTo === null && leg.to !== null) update.transferTo = leg.to;
  if (update.transferFrom === undefined && update.transferTo === undefined) return null;
  const stillMissing =
    (row.transferFrom === null && leg.from === null) || (row.transferTo === null && leg.to === null);
  if (!stillMissing && row.reviewStatus === "needs_review") update.reviewStatus = "confirmed";
  return update;
}

/**
 * Another email of the SAME type (same alert kind, same merchant key) is a
 * second, separate transfer — two $500 savings transfers in one week are two
 * transfers — unless it is the same email again: this very event, an
 * identical body, or the other person's inbox forwarding the same alert (the
 * rule findDuplicateAlert uses).
 */
function isSeparateSameTypeEmail(c: CandidateRow, ctx: DecideContext): boolean {
  if (c.emailEventId === null) return false;
  if (c.eventKind !== ctx.alert.kind || c.eventMerchantKey !== ctx.merchantKey) return false;
  const sameEmail =
    c.emailEventId === ctx.event.id ||
    c.eventBodySha256 === ctx.event.bodySha256 ||
    (c.eventForwardedFor ?? "") !== (ctx.event.forwardedFor ?? "");
  return !sameEmail;
}

/**
 * A card payment seen from both ends, each naming only its own side: the
 * paying bank's line ("CAPITAL ONE ONLINE PMT" — no card) and the card's
 * "payment received" (no paying account). Neither shares a known side with
 * the other, so matchingTransfer can't pair them; whichever arrives second
 * completes the first. Only into a credit card, and only when exactly one
 * transfer is waiting — never a guess between two.
 */
function waitingOtherHalf(
  ctx: DecideContext,
  leg: { from: string | null; to: string | null },
  windowDays: number,
): CandidateRow | null {
  const isCard = (id: string | null) => id !== null && ctx.accounts.some((x) => x.id === id && x.kind === "credit_card");
  const knowsFrom = leg.from !== null && leg.to === null;
  const knowsTo = leg.from === null && leg.to !== null;
  if (!knowsFrom && !knowsTo) return null;
  const hits = ctx.candidates.filter(
    (c) =>
      c.kind === "transfer" &&
      c.reviewStatus === "needs_review" &&
      c.amountCents === ctx.alert.amountCents &&
      dayDiff(c.occurredAt, ctx.occurredAt, ctx.timeZone) <= windowDays &&
      (knowsFrom
        ? c.transferFrom === null && isCard(c.transferTo) && c.transferTo !== leg.from
        : c.transferTo === null && c.transferFrom !== null && isCard(leg.to) && c.transferFrom !== leg.to),
  );
  return hits.length === 1 ? hits[0] : null;
}

type TransferFlavor = "venmo" | "account";

const TRANSFER_REASONS: Record<TransferFlavor, { completed: string; recorded: string; unknown: string; created: string }> = {
  venmo: {
    completed: "completed_venmo_side",
    recorded: "venmo_transfer_already_recorded",
    unknown: "venmo_transfer_side_unknown",
    created: "venmo_transfer",
  },
  account: {
    completed: "completed_transfer_side",
    recorded: "transfer_already_recorded",
    unknown: "transfer_side_unknown",
    created: "account_transfer",
  },
};

/**
 * One transfer row per real movement of money. A leg that matches a transfer
 * already recorded — by a hand entry, or by the other bank's email — links to
 * it (filling in a side that was unknown) instead of adding a second row.
 */
function decideTransfer(ctx: DecideContext, leg: Leg | AccountLeg, flavor: TransferFlavor): Plan {
  const cfg = cfgOf(ctx);
  const reasons = TRANSFER_REASONS[flavor];
  const existing =
    flavor === "venmo"
      ? matchingTransfer(ctx, leg)
      : matchingTransfer(ctx, leg, cfg.transferMatchWindowDays).filter((c) => !isSeparateSameTypeEmail(c, ctx));
  if (existing.length >= 1) {
    const row = existing[0];
    const fill = fillUnknownSides(row, leg);
    const manual = row.emailEventId === null && (row.source === "manual" || row.source === "shortcut");
    if (manual) {
      // Manual transfer vs email transfer: link; no second transfer.
      return {
        action: "link",
        status: "linked",
        reason: "matched_manual_transfer",
        transactionId: row.id,
        update: { ...(fill ?? { id: row.id }), attachEvent: true },
      };
    }
    if (fill) {
      return { action: "link", status: "linked", reason: reasons.completed, transactionId: row.id, update: fill };
    }
    return duplicate(row.id, reasons.recorded);
  }

  if (flavor === "account") {
    const windowDays = ctx.alert.postedSummary ? cfg.postedSummaryMatchDays : cfg.transferMatchWindowDays;
    const half = waitingOtherHalf(ctx, leg, windowDays);
    const fill = half ? fillUnknownSides(half, leg) : null;
    if (half && fill) {
      return { action: "link", status: "linked", reason: reasons.completed, transactionId: half.id, update: fill };
    }
  }

  const unknownSide = leg.from === null || leg.to === null;
  return {
    action: "create",
    status: "created",
    reason: unknownSide ? reasons.unknown : reasons.created,
    transactions: [
      {
        ref: "primary",
        kind: "transfer",
        amountCents: ctx.alert.amountCents,
        category: null,
        description: leg.description,
        account: null,
        transferFrom: leg.from,
        transferTo: leg.to,
        reviewStatus: unknownSide ? "needs_review" : "confirmed",
        categorizedBy: null,
        isPending: false,
        attachMerchant: false,
        attachEvent: true,
      },
    ],
    updates: [],
    notify: false, // "Which account?" never pushes — the other side often fills itself in
    choices: "all",
  };
}

type AccountLeg = { from: string | null; to: string | null; description: string };

/**
 * The account an email names by its last four, as the OTHER side of a
 * transfer. Prefer this parser's own accounts (a Wells Fargo email naming
 * ••2222 means the Wells Fargo card), then any single account with those
 * digits. Several, or none: unknown — never a guess.
 */
function counterpartByLast4(ctx: DecideContext, hint: AccountHint | "balance" | undefined): AccountRef | null {
  if (!hint || hint === "balance" || !hint.last4) return null;
  const hits = ctx.accounts.filter((a) => a.alertLast4 === hint.last4);
  const own = hits.filter((a) => a.alertSource === ctx.parser.id);
  if (own.length === 1) return own[0];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A card payment or transfer between your own accounts, from a bank or card
 * alert (`kind: "transfer"`). The alert's account is one side; the other is
 * the account the email names, or unknown — then it waits for the other
 * bank's email, a hand-logged transfer, or an answer in To categorize.
 */
export function accountTransferLeg(ctx: DecideContext): AccountLeg | null {
  const a = ctx.alert;
  if (ctx.parser.id === "venmo" || a.kind !== "transfer") return null;
  const out = a.transferDirection !== "in";
  // Money in from outside your accounts (card rewards): "Other" → this
  // account, named by its source, like a hand-logged one.
  if (!out && a.externalFrom) return { from: a.externalFrom, to: ctx.account.id, description: merchantName(ctx) };
  const other = counterpartByLast4(ctx, a.fundingSource)?.id ?? null;
  const from = out ? ctx.account.id : other;
  const to = out ? other : ctx.account.id;
  const toKind = ctx.accounts.find((x) => x.id === to)?.kind;
  // "payment" / "transfer" in the logged row is what Reconcile's transfer step
  // looks for, so these reconcile exactly like a hand-logged transfer.
  const description =
    toKind === "credit_card" || /\b(?:payment|pmt)\b/i.test(a.merchantRaw) ? "Card payment" : "Transfer";
  return { from, to, description };
}

/**
 * A Venmo "You paid" receipt: the expense on Venmo, plus — when it names an
 * external card/bank — the transfer card → Venmo, unless the card's own alert
 * already recorded it. Also completes a transfer waiting on "which Venmo?".
 */
function venmoPaymentExtras(ctx: DecideContext): { transactions: NewTransaction[]; updates: RowUpdate[] } {
  const cfg = cfgOf(ctx);
  const a = ctx.alert;
  const empty = { transactions: [], updates: [] };
  if (!cfg.enableVenmoTransfers || ctx.parser.id !== "venmo" || a.kind !== "payment_sent") return empty;

  // A bank alert that arrived first and is waiting for its Venmo side.
  const waiting = ctx.candidates.filter(
    (c) =>
      c.kind === "transfer" &&
      c.reviewStatus === "needs_review" &&
      c.transferTo === null &&
      c.transferFrom !== null &&
      c.amountCents === a.amountCents &&
      dayDiff(c.occurredAt, ctx.occurredAt, ctx.timeZone) <= cfg.venmoCardMatchWindowDays,
  );
  if (waiting.length >= 1) {
    return {
      transactions: [],
      updates: [{ id: waiting[0].id, transferTo: ctx.account.id, reviewStatus: "confirmed" }],
    };
  }

  const funding = accountByLast4(ctx, a.fundingSource);
  if (!funding) return empty; // paid from the Venmo balance, or a card Stash doesn't track
  if (matchingTransfer(ctx, { from: funding.id, to: ctx.account.id }).length > 0) return empty;
  return {
    transactions: [
      {
        ref: "venmo_transfer",
        kind: "transfer",
        amountCents: a.amountCents,
        category: null,
        description: "Venmo transfer",
        account: null,
        transferFrom: funding.id,
        transferTo: ctx.account.id,
        reviewStatus: "confirmed",
        categorizedBy: null,
        isPending: false,
        attachMerchant: false,
        attachEvent: false,
      },
    ],
    updates: [],
  };
}

// ---- Venmo money received ----------------------------------------------------

/**
 * The external transfer source for money a person sends you on Venmo — one of
 * the pickers' EXTERNAL_TRANSFER_SOURCES (services/accountBalancesService.ts),
 * so it reads exactly like a hand-logged "Other → Venmo" transfer.
 */
export const VENMO_RECEIVED_FROM = "Other";

/**
 * "Alex paid you $20": a transfer from "Other" into that Venmo account, not
 * Income. Someone paying you back is squaring up, not earning — Daniel's own
 * convention for these (2026-11-16), which replaces D1 for Venmo. The account
 * balance moves; the budget doesn't. The description is the note as typed.
 *
 * Paired only with the same receipt again or a hand-logged transfer into this
 * Venmo — never with another person's payment of the same amount.
 */
function decideVenmoReceived(ctx: DecideContext): Plan {
  const cfg = cfgOf(ctx);
  const a = ctx.alert;
  const window = cfg.duplicateAlertWindowMinutes * 60_000;

  // The same receipt again: redelivered, or forwarded from the other inbox
  // (the rule findDuplicateAlert uses for purchases).
  const again = ctx.candidates.find(
    (c) =>
      c.emailEventId !== null &&
      c.kind === "transfer" &&
      c.transferTo === ctx.account.id &&
      c.eventKind === a.kind &&
      c.amountCents === a.amountCents &&
      c.eventMerchantKey === ctx.merchantKey &&
      Math.abs(ms(c.occurredAt) - ms(ctx.occurredAt)) <= window &&
      c.eventGmailMessageId !== ctx.event.gmailMessageId &&
      (c.eventBodySha256 === ctx.event.bodySha256 || (c.eventForwardedFor ?? "") !== (ctx.event.forwardedFor ?? "")),
  );
  if (again) return duplicate(again.id, "same_alert");

  // Already logged by hand: a transfer into this Venmo of the same amount.
  const manual = ctx.candidates.filter(
    (c) =>
      c.kind === "transfer" &&
      c.emailEventId === null &&
      (c.source === "manual" || c.source === "shortcut") &&
      c.transferTo === ctx.account.id &&
      c.amountCents === a.amountCents &&
      dayDiff(c.occurredAt, ctx.occurredAt, ctx.timeZone) <= cfg.manualMatchWindowDays,
  );
  if (manual.length === 1) {
    return {
      action: "link",
      status: "linked",
      reason: "matched_manual_transfer",
      transactionId: manual[0].id,
      update: { id: manual[0].id, attachEvent: true },
    };
  }

  return {
    action: "create",
    status: "created",
    reason: "venmo_received",
    transactions: [
      {
        ref: "primary",
        kind: "transfer",
        amountCents: a.amountCents,
        category: null,
        description: describe(ctx, "income"),
        account: null,
        transferFrom: VENMO_RECEIVED_FROM,
        transferTo: ctx.account.id,
        reviewStatus: "confirmed",
        categorizedBy: null,
        isPending: false,
        attachMerchant: false,
        attachEvent: true,
      },
    ],
    updates: [],
    notify: false, // nothing to ask
    choices: "all",
  };
}

// ---- posted-activity summaries ---------------------------------------------

function isMoneyOut(a: ParsedAlert): boolean {
  if (a.kind === "transfer") return a.transferDirection !== "in";
  return a.kind !== "refund" && a.kind !== "payment_received";
}

/** Two lines of the SAME summary are separate items, however alike. */
function sameSummary(c: CandidateRow, ctx: DecideContext): boolean {
  return (
    c.eventGmailMessageId !== null &&
    c.eventGmailMessageId !== ctx.event.gmailMessageId &&
    wholeEmailId(c.eventGmailMessageId) === wholeEmailId(ctx.event.gmailMessageId)
  );
}

/**
 * A summary line repeats activity that already posted — a Bill Pay, a card
 * payment, a paycheck, something logged by hand — so it is only news when
 * NOTHING on this account shows it: same amount, same direction, within
 * `postedSummaryMatchDays`. The bias is deliberate: doubling is worse than
 * leaving one rare same-amount repeat to Reconcile.
 */
export function alreadyRecorded(ctx: DecideContext): CandidateRow | null {
  const cfg = cfgOf(ctx);
  const a = ctx.alert;
  const acct = ctx.account.id;
  const out = isMoneyOut(a);
  const onThisAccount = (c: CandidateRow) =>
    c.account === acct ||
    (c.emailEventId === null &&
      (c.source === "manual" || c.source === "shortcut") &&
      (c.account === null || c.account === ctx.defaultAccountId));
  const sameAmount = (c: CandidateRow) =>
    c.amountCents === a.amountCents ||
    c.originalAmountCents === a.amountCents ||
    // A pending purchase alert whose final (tipped / gas) amount this posted.
    (c.kind === "expense" && c.isPending && amountsCompatible(a.amountCents, c.amountCents, c.category, true, cfg));
  const hits = ctx.candidates.filter(
    (c) =>
      c.emailEventId !== ctx.event.id &&
      !sameSummary(c, ctx) &&
      sameAmount(c) &&
      dayDiff(c.occurredAt, ctx.occurredAt, ctx.timeZone) <= cfg.postedSummaryMatchDays &&
      (out
        ? (c.kind === "expense" && onThisAccount(c)) || (c.kind === "transfer" && c.transferFrom === acct)
        : (c.kind === "income" && onThisAccount(c)) || (c.kind === "transfer" && c.transferTo === acct)),
  );
  return hits[0] ?? null;
}

function decidePostedSummary(ctx: DecideContext): Plan | null {
  const a = ctx.alert;
  if (!a.postedSummary) return null;

  const row = alreadyRecorded(ctx);
  if (row) {
    const manual = row.emailEventId === null && (row.source === "manual" || row.source === "shortcut");
    if (!manual) return duplicate(row.id, "already_recorded");
    if (row.kind === "transfer") {
      return {
        action: "link",
        status: "linked",
        reason: "matched_manual_transfer",
        transactionId: row.id,
        update: { id: row.id, attachEvent: true },
      };
    }
    return linkManual(ctx, row, row.kind === "income" ? "income" : "expense");
  }
  return null; // news: the usual rules below decide what it becomes
}

// ---- entry point --------------------------------------------------------------

function decideIncome(ctx: DecideContext): Plan {
  const dup = findDuplicateAlert(ctx, "income");
  if (dup) return duplicate(dup.id, "same_alert");
  const manual = manualCandidates(ctx, "income");
  if (manual.length === 1) return linkManual(ctx, manual[0], "income");
  return {
    action: "create",
    status: "created",
    reason: ctx.alert.kind === "refund" ? "refund_as_income" : "money_in_as_income",
    transactions: [
      {
        ref: "primary",
        kind: "income",
        amountCents: ctx.alert.amountCents,
        category: "Income",
        description: describe(ctx, "income"),
        account: ctx.account.id,
        transferFrom: null,
        transferTo: null,
        reviewStatus: "confirmed",
        categorizedBy: "rule",
        isPending: false,
        // A deposit's source becomes a merchant so it can be named (Rules →
        // Money in). Its category settings never apply: money in is Income.
        attachMerchant: ctx.alert.kind === "payment_received",
        attachEvent: true,
      },
    ],
    updates: [],
    notify: false, // D1: no question, no push
    choices: "all",
  };
}

function decideExpense(ctx: DecideContext): Plan {
  const a = ctx.alert;
  const dup = findDuplicateAlert(ctx, "expense");
  if (dup) return duplicate(dup.id, "same_alert");

  const explicit = explicitFollowup(ctx);
  if (explicit) return explicit;

  const late = outOfOrder(ctx);
  if (late) return late;

  const merged = heuristicFollowup(ctx);
  if (merged) return merged;

  const manual = manualCandidates(ctx, "expense");
  if (manual.length === 1) return linkManual(ctx, manual[0], "expense");

  // A Venmo payment is to a PERSON: never guessed, always asked, unless you
  // said "Always file <name> this way" (rules.ts).
  const category = decideCategory(ctx.merchant, ctx.merchantKey, { person: ctx.parser.id === "venmo" });
  const extras = venmoPaymentExtras(ctx);
  return {
    action: "create",
    status: "created",
    reason: category.reviewStatus === "confirmed" ? "auto_rule" : category.category ? "ask_with_guess" : "ask",
    transactions: [
      {
        ref: "primary",
        kind: "expense",
        amountCents: a.amountCents,
        category: category.category,
        description: describe(ctx, "expense"),
        account: ctx.account.id,
        transferFrom: null,
        transferTo: null,
        reviewStatus: category.reviewStatus,
        categorizedBy: category.categorizedBy,
        // Only an authorization can be updated later. A posted alert with no
        // candidate is a first sighting and is final.
        isPending: a.kind === "purchase" && a.isPending,
        attachMerchant: true,
        attachEvent: true,
      },
      ...extras.transactions,
    ],
    updates: extras.updates,
    notify: category.reviewStatus === "needs_review",
    choices: category.choices,
  };
}

export function decide(ctx: DecideContext): Plan {
  const cfg = cfgOf(ctx);
  const a = ctx.alert;

  if (a.kind === "declined") return ignore("declined");

  if (a.counterparty && ctx.internalCounterparties.includes(normName(a.counterparty))) {
    return ignore("internal_counterparty");
  }

  // A posted-activity summary line: first, is it already recorded?
  const posted = decidePostedSummary(ctx);
  if (posted) return posted;

  const leg = venmoLeg(ctx);
  if (leg) {
    return cfg.enableVenmoTransfers ? decideTransfer(ctx, leg, "venmo") : ignore("venmo_leg_pending_phase4");
  }

  // Card payments and other account-to-account moves: a transfer row. Never
  // Income — a card payment misread as a refund would invent it.
  if (a.kind === "transfer") {
    const move = cfg.enableAccountTransfers ? accountTransferLeg(ctx) : null;
    if (!move) return ignore("transfer_not_tracked");
    if (move.from !== null && move.from === move.to) return ignore("transfer_same_account");
    return decideTransfer(ctx, move, "account");
  }

  if (ctx.parser.id === "venmo" && a.kind === "payment_received") return decideVenmoReceived(ctx);
  if (a.kind === "refund" || a.kind === "payment_received") return decideIncome(ctx);

  return decideExpense(ctx);
}
