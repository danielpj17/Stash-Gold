import { describe, expect, it } from "vitest";
import { decide, isGasHold, type AccountRef, type CandidateRow, type DecideContext } from "@/lib/email/decide";
import { merchantKey } from "@/lib/email/merchantKey";
import type { MerchantRule } from "@/lib/email/rules";
import type { ParsedAlert } from "@/lib/email/types";

// ---- builders ----------------------------------------------------------------

const CARD: AccountRef = {
  id: "acct-card",
  name: "Joint Visa",
  kind: "credit_card",
  isDefault: false,
  alertSource: "examplebank",
  alertLast4: "4821",
  alertForwardedFrom: null,
  unattendedAction: "keep_in_review",
};
const CHECKING: AccountRef = { ...CARD, id: "acct-checking", name: "Checking", kind: "checking", isDefault: true, alertLast4: "1111" };
const VENMO_D: AccountRef = {
  ...CARD,
  id: "acct-venmo-d",
  name: "Daniel Venmo",
  kind: "other",
  alertSource: "venmo",
  alertLast4: null,
  alertForwardedFrom: "daniel@example.com",
};
const VENMO_K: AccountRef = { ...VENMO_D, id: "acct-venmo-k", name: "Katie Venmo", alertForwardedFrom: "katie@example.com" };

const T0 = "2026-11-10T19:00:00.000Z";
const hours = (h: number) => new Date(Date.parse(T0) + h * 3_600_000).toISOString();

function alert(over: Partial<ParsedAlert> = {}): ParsedAlert {
  return {
    kind: "purchase",
    amountCents: 1482,
    merchantRaw: "MCDONALD'S F1234",
    accountHint: { last4: "4821" },
    occurredAt: null,
    occurredDate: null,
    isPending: true,
    ...over,
  };
}

function row(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: "row-1",
    kind: "expense",
    occurredAt: T0,
    createdAt: T0,
    amountCents: 1482,
    originalAmountCents: null,
    category: null,
    reviewStatus: "needs_review",
    source: "email",
    account: CARD.id,
    transferFrom: null,
    transferTo: null,
    isPending: true,
    merchantId: "m-mcd",
    emailEventId: "ev-old",
    autoMerged: false,
    claimed: false,
    eventGmailMessageId: "gm-old",
    eventBodySha256: "sha-old",
    eventForwardedFor: "daniel@example.com",
    eventKind: "purchase",
    eventMerchantKey: merchantKey("MCDONALD'S F1234"),
    ...over,
  };
}

const MCD: MerchantRule = {
  id: "m-mcd",
  displayName: "McDonald's",
  mode: "ask_shortlist",
  category: null,
  shortlist: ["Eating Out", "Dates"],
  defaultCategory: "Eating Out",
};

function ctx(over: Partial<DecideContext> & { alert?: ParsedAlert } = {}): DecideContext {
  const a = over.alert ?? alert();
  return {
    mode: "live",
    timeZone: "America/Denver",
    internalCounterparties: ["sam lee"],
    parser: { id: "examplebank", accountKey: "last4" },
    event: {
      id: "ev-new",
      gmailMessageId: "gm-new",
      bodySha256: "sha-new",
      forwardedFor: "daniel@example.com",
      receivedAt: T0,
    },
    occurredAt: T0,
    merchantKey: merchantKey(a.merchantRaw),
    merchant: MCD,
    account: CARD,
    accounts: [CARD, CHECKING],
    defaultAccountId: CHECKING.id,
    candidates: [],
    ...over,
    alert: a,
  };
}

// ---- tests ------------------------------------------------------------------

describe("decide: new purchases and rules", () => {
  it("auto merchant files confirmed with no push", () => {
    const plan = decide(
      ctx({ merchant: { ...MCD, mode: "auto", category: "Groceries" } }),
    );
    expect(plan.action).toBe("create");
    if (plan.action !== "create") return;
    expect(plan.transactions[0]).toMatchObject({
      kind: "expense",
      category: "Groceries",
      reviewStatus: "confirmed",
      categorizedBy: "rule",
    });
    expect(plan.notify).toBe(false);
  });

  it("shortlist merchant waits for an answer, counting its default provisionally (D2)", () => {
    const plan = decide(ctx());
    expect(plan.action).toBe("create");
    if (plan.action !== "create") return;
    expect(plan.transactions[0]).toMatchObject({
      category: "Eating Out",
      reviewStatus: "needs_review",
      categorizedBy: "guess",
      isPending: true,
    });
    expect(plan.choices).toEqual(["Eating Out", "Dates"]);
    expect(plan.notify).toBe(true);
  });

  it("a brand-new merchant uses the starter guess, else no category at all", () => {
    const gas = decide(ctx({ merchant: null, alert: alert({ merchantRaw: "CHEVRON #412 OGDEN UT" }) }));
    expect(gas.action === "create" && gas.transactions[0].category).toBe("Gas");
    const none = decide(ctx({ merchant: null, alert: alert({ merchantRaw: "JOES BIKE SHOP" }) }));
    expect(none.action === "create" && none.transactions[0]).toMatchObject({
      category: null,
      categorizedBy: null,
      reviewStatus: "needs_review",
    });
  });

  it("declined alerts never create anything", () => {
    expect(decide(ctx({ alert: alert({ kind: "declined" }) }))).toMatchObject({ action: "ignore", reason: "declined" });
  });
});

describe("decide: duplicate alerts (plan §5.7)", () => {
  it("the joint card forwarded from both inboxes produces one row", () => {
    const plan = decide(
      ctx({
        event: { id: "ev-new", gmailMessageId: "gm-new", bodySha256: "sha-x", forwardedFor: "katie@example.com", receivedAt: T0 },
        candidates: [row({ eventKind: "purchase", occurredAt: hours(-0.05) })],
      }),
    );
    expect(plan).toMatchObject({ action: "duplicate", transactionId: "row-1" });
  });

  it("a Gmail redelivery (identical body) is a duplicate", () => {
    const plan = decide(
      ctx({
        event: { id: "ev-new", gmailMessageId: "gm-new", bodySha256: "sha-old", forwardedFor: "daniel@example.com", receivedAt: T0 },
        candidates: [row()],
      }),
    );
    expect(plan.action).toBe("duplicate");
  });

  it("two genuine same-amount purchases from the same inbox stay two", () => {
    const plan = decide(ctx({ candidates: [row({ isPending: false })] }));
    expect(plan.action).toBe("create");
  });
});

describe("decide: explicit follow-ups (Phase 3)", () => {
  const posted = alert({ kind: "posted", amountCents: 1750, isPending: false });

  it("pending → posted with a new amount updates the one row", () => {
    const plan = decide(ctx({ alert: posted, occurredAt: hours(30), candidates: [row({ category: "Eating Out" })] }));
    expect(plan).toMatchObject({
      action: "followup",
      transactionId: "row-1",
      oldAmountCents: 1482,
      newAmountCents: 1750,
      changeReason: "tip",
      autoMerged: false,
      isPending: false,
    });
  });

  it("same amount only clears pending", () => {
    const plan = decide(ctx({ alert: { ...posted, amountCents: 1482 }, occurredAt: hours(30), candidates: [row()] }));
    expect(plan).toMatchObject({ action: "followup", reason: "posted_same_amount", newAmountCents: 1482 });
  });

  it("two candidates: create nothing, ask which purchase", () => {
    const plan = decide(
      ctx({ alert: posted, occurredAt: hours(30), candidates: [row(), row({ id: "row-2", emailEventId: "ev-2" })] }),
    );
    expect(plan).toMatchObject({ action: "ambiguous", candidateIds: ["row-1", "row-2"] });
  });

  it("never changes a claimed row (C21)", () => {
    const plan = decide(ctx({ alert: posted, occurredAt: hours(30), candidates: [row({ claimed: true })] }));
    expect(plan).toMatchObject({ action: "followup_ignored", status: "followup_ignored_reconciled" });
  });

  it("no candidate: a first sighting creates a final (not pending) row", () => {
    const plan = decide(ctx({ alert: posted }));
    expect(plan.action === "create" && plan.transactions[0].isPending).toBe(false);
  });
});

describe("decide: heuristic follow-ups (Phase 4, D3)", () => {
  const gasMerchant: MerchantRule = { id: "m-mav", displayName: "Maverik", mode: "auto", category: "Gas", shortlist: [], defaultCategory: "Gas" };
  const gasRow = (over: Partial<CandidateRow> = {}) =>
    row({
      merchantId: "m-mav",
      amountCents: 100,
      category: "Gas",
      reviewStatus: "confirmed",
      eventMerchantKey: "MAVERIK",
      ...over,
    });
  const fill = alert({ merchantRaw: "MAVERIK #412", amountCents: 4317 });

  it("a $1.00 gas hold followed by the fill-up merges, auto_merged", () => {
    const plan = decide(ctx({ alert: fill, merchant: gasMerchant, occurredAt: hours(0.2), candidates: [gasRow()] }));
    expect(plan).toMatchObject({ action: "followup", changeReason: "gas_final", autoMerged: true, newAmountCents: 4317 });
  });

  it("two $1.00 holds stay two (C20)", () => {
    const plan = decide(
      ctx({ alert: { ...fill, amountCents: 100 }, merchant: gasMerchant, occurredAt: hours(48), candidates: [gasRow()] }),
    );
    expect(plan.action).toBe("create");
  });

  it("two fill-ups two days apart stay two", () => {
    const plan = decide(
      ctx({ alert: fill, merchant: gasMerchant, occurredAt: hours(48), candidates: [gasRow({ amountCents: 3900 })] }),
    );
    expect(plan.action).toBe("create");
  });

  it("a tip merges only after the 12 h gap and within 35%", () => {
    const tipped = alert({ amountCents: 1750 });
    const early = decide(ctx({ alert: tipped, occurredAt: hours(2), candidates: [row({ category: "Eating Out" })] }));
    expect(early.action).toBe("create");
    const late = decide(ctx({ alert: tipped, occurredAt: hours(20), candidates: [row({ category: "Eating Out" })] }));
    expect(late).toMatchObject({ action: "followup", changeReason: "tip", autoMerged: true });
    const tooMuch = decide(ctx({ alert: alert({ amountCents: 2500 }), occurredAt: hours(20), candidates: [row({ category: "Eating Out" })] }));
    expect(tooMuch.action).toBe("create");
  });

  it("two pending dinners at the same place: no merge, a separate row", () => {
    const plan = decide(
      ctx({
        alert: alert({ amountCents: 1750 }),
        occurredAt: hours(20),
        candidates: [row({ category: "Eating Out" }), row({ id: "row-2", emailEventId: "ev-2", category: "Eating Out" })],
      }),
    );
    expect(plan.action).toBe("create");
  });

  it("an authorization arriving after its posted row is a duplicate", () => {
    const plan = decide(
      ctx({
        occurredAt: hours(-1),
        candidates: [row({ isPending: false, eventKind: "posted", occurredAt: hours(5), eventGmailMessageId: "gm-p", eventBodySha256: "sha-p" })],
      }),
    );
    expect(plan).toMatchObject({ action: "duplicate", reason: "authorization_after_posted" });
  });

  it("switching a heuristic off makes it a separate purchase (the Phase 4 rollback)", () => {
    const plan = decide(
      ctx({
        alert: fill,
        merchant: gasMerchant,
        occurredAt: hours(0.2),
        candidates: [gasRow()],
        config: { enableGasHoldHeuristic: false },
      }),
    );
    expect(plan.action).toBe("create");
  });
});

describe("decide: manual entries (plan §5.7, C18)", () => {
  const manual = (over: Partial<CandidateRow> = {}) =>
    row({
      id: "manual-1",
      source: "shortcut",
      emailEventId: null,
      merchantId: null,
      eventGmailMessageId: null,
      eventBodySha256: null,
      eventForwardedFor: null,
      eventKind: null,
      eventMerchantKey: null,
      account: CHECKING.id, // the default — New Expense has no account picker
      category: "Eating Out",
      reviewStatus: "confirmed",
      isPending: false,
      amountCents: 1240,
      ...over,
    });

  it("Shortcut first, alert second: link, and move the row to the alert's account", () => {
    const plan = decide(ctx({ alert: alert({ amountCents: 1240 }), candidates: [manual({ occurredAt: hours(-3) })] }));
    expect(plan).toMatchObject({
      action: "link",
      transactionId: "manual-1",
      update: { account: CARD.id, attachEvent: true, attachMerchant: true },
    });
  });

  it("a manual row on some OTHER non-default account doesn't match", () => {
    const plan = decide(ctx({ alert: alert({ amountCents: 1240 }), candidates: [manual({ account: "acct-other" })] }));
    expect(plan.action).toBe("create");
  });

  it("two possible manual rows: link neither", () => {
    const plan = decide(
      ctx({ alert: alert({ amountCents: 1240 }), candidates: [manual(), manual({ id: "manual-2" })] }),
    );
    expect(plan.action).toBe("create");
  });

  it("more than 2 days apart doesn't match", () => {
    const plan = decide(ctx({ alert: alert({ amountCents: 1240 }), candidates: [manual({ occurredAt: hours(-24 * 4) })] }));
    expect(plan.action).toBe("create");
  });

  it("Phase 4 tolerance: a hand-logged tipped total links to the pre-tip alert", () => {
    const plan = decide(ctx({ alert: alert({ amountCents: 1482 }), candidates: [manual({ amountCents: 1750 })] }));
    expect(plan.action).toBe("link");
  });
});

describe("decide: money in (D1, §5.12)", () => {
  it("a refund becomes confirmed Income with no push", () => {
    const plan = decide(
      ctx({ merchant: null, alert: alert({ kind: "refund", amountCents: 2599, merchantRaw: "AMAZON.COM*AB12C", isPending: false }) }),
    );
    expect(plan.action).toBe("create");
    if (plan.action !== "create") return;
    expect(plan.transactions[0]).toMatchObject({
      kind: "income",
      category: "Income",
      reviewStatus: "confirmed",
      categorizedBy: "rule",
      description: "Refund · Amazon",
    });
    expect(plan.notify).toBe(false);
  });

  it("a card payment is never income", () => {
    const plan = decide(ctx({ alert: alert({ kind: "transfer", merchantRaw: "PAYMENT THANK YOU", isPending: false }) }));
    expect(plan).toMatchObject({ action: "ignore", reason: "transfer_not_tracked" });
  });

  it("Venmo 'X paid you' is Income on the Venmo account", () => {
    const plan = decide(
      ctx({
        parser: { id: "venmo", accountKey: "forwarded_from" },
        account: VENMO_D,
        accounts: [CARD, CHECKING, VENMO_D],
        merchant: null,
        alert: alert({ kind: "payment_received", merchantRaw: "Alex Smith", counterparty: "Alex Smith", memo: "pizza", accountHint: {}, isPending: false, amountCents: 1500 }),
      }),
    );
    expect(plan.action === "create" && plan.transactions[0]).toMatchObject({
      kind: "income",
      account: VENMO_D.id,
      description: "pizza",
    });
  });

  it("a hand-logged paycheck isn't doubled by its deposit alert", () => {
    const plan = decide(
      ctx({
        account: CHECKING,
        alert: alert({ kind: "payment_received", merchantRaw: "ACME PAYROLL", accountHint: { last4: "1111" }, amountCents: 250000, isPending: false }),
        candidates: [
          row({ id: "pay-1", kind: "income", category: "Income", source: "manual", emailEventId: null, account: CHECKING.id, amountCents: 250000, isPending: false, eventKind: null, eventMerchantKey: null }),
        ],
      }),
    );
    expect(plan).toMatchObject({ action: "link", transactionId: "pay-1" });
  });

  it("payments between the two of us are ignored (D6)", () => {
    const plan = decide(
      ctx({
        parser: { id: "venmo", accountKey: "forwarded_from" },
        account: VENMO_D,
        alert: alert({ kind: "payment_sent", merchantRaw: "Sam Lee", counterparty: "Sam  Lee", accountHint: {}, isPending: false }),
      }),
    );
    expect(plan).toMatchObject({ action: "ignore", reason: "internal_counterparty" });
  });
});

describe("decide: Venmo legs (D4)", () => {
  const venmoCtx = (over: Partial<DecideContext> = {}) =>
    ctx({
      parser: { id: "venmo", accountKey: "forwarded_from" },
      account: VENMO_D,
      accounts: [CARD, CHECKING, VENMO_D],
      merchant: null,
      ...over,
    });
  const paid = (over: Partial<ParsedAlert> = {}) =>
    alert({
      kind: "payment_sent",
      merchantRaw: "Alex Smith",
      counterparty: "Alex Smith",
      accountHint: {},
      isPending: false,
      amountCents: 2000,
      fundingSource: { last4: "4821" },
      ...over,
    });
  const cardVenmo = alert({ merchantRaw: "VENMO* Visa Direct", amountCents: 2000, isPending: false });

  it("card alert for VENMO is never an expense: it's a transfer card → Venmo", () => {
    const plan = decide(ctx({ alert: cardVenmo, accounts: [CARD, CHECKING, VENMO_D], merchant: null }));
    expect(plan.action).toBe("create");
    if (plan.action !== "create") return;
    expect(plan.transactions).toHaveLength(1);
    expect(plan.transactions[0]).toMatchObject({
      kind: "transfer",
      transferFrom: CARD.id,
      transferTo: VENMO_D.id,
      reviewStatus: "confirmed",
      description: "Venmo transfer",
    });
    expect(plan.notify).toBe(false);
  });

  it("Phase 3 guard: with transfers switched off, a VENMO card line is ignored", () => {
    const plan = decide(ctx({ alert: cardVenmo, merchant: null, config: { enableVenmoTransfers: false } }));
    expect(plan).toMatchObject({ action: "ignore", reason: "venmo_leg_pending_phase4" });
  });

  it("Venmo receipt first: expense on Venmo plus the card → Venmo transfer", () => {
    const plan = decide(venmoCtx({ alert: paid() }));
    expect(plan.action).toBe("create");
    if (plan.action !== "create") return;
    expect(plan.transactions.map((t) => [t.kind, t.ref])).toEqual([
      ["expense", "primary"],
      ["transfer", "venmo_transfer"],
    ]);
    expect(plan.transactions[0]).toMatchObject({ account: VENMO_D.id, description: "Venmo to Alex Smith" });
    expect(plan.transactions[1]).toMatchObject({ transferFrom: CARD.id, transferTo: VENMO_D.id });
  });

  it("…then the card alert arrives second: a duplicate of that transfer", () => {
    const transfer = row({
      id: "xfer-1",
      kind: "transfer",
      account: null,
      transferFrom: CARD.id,
      transferTo: VENMO_D.id,
      emailEventId: null,
      amountCents: 2000,
      reviewStatus: "confirmed",
      eventKind: null,
    });
    const plan = decide(ctx({ alert: cardVenmo, accounts: [CARD, CHECKING, VENMO_D], merchant: null, candidates: [transfer] }));
    expect(plan).toMatchObject({ action: "duplicate", transactionId: "xfer-1" });
  });

  it("card alert first: the Venmo receipt creates only the expense", () => {
    const transfer = row({
      id: "xfer-1",
      kind: "transfer",
      account: null,
      transferFrom: CARD.id,
      transferTo: VENMO_D.id,
      emailEventId: "ev-card",
      amountCents: 2000,
      reviewStatus: "confirmed",
      eventKind: "purchase",
    });
    const plan = decide(venmoCtx({ alert: paid(), candidates: [transfer] }));
    expect(plan.action === "create" && plan.transactions.map((t) => t.kind)).toEqual(["expense"]);
  });

  it("paid from the Venmo balance: only the expense", () => {
    const plan = decide(venmoCtx({ alert: paid({ fundingSource: "balance" }) }));
    expect(plan.action === "create" && plan.transactions).toHaveLength(1);
  });

  it("two Venmo accounts and the card alert first: 'Which Venmo account?'", () => {
    const plan = decide(ctx({ alert: cardVenmo, accounts: [CARD, CHECKING, VENMO_D, VENMO_K], merchant: null }));
    expect(plan.action === "create" && plan.transactions[0]).toMatchObject({
      kind: "transfer",
      transferFrom: CARD.id,
      transferTo: null,
      reviewStatus: "needs_review",
    });
  });

  it("…which the Venmo receipt then fills in and confirms", () => {
    const waiting = row({
      id: "xfer-wait",
      kind: "transfer",
      account: null,
      transferFrom: CARD.id,
      transferTo: null,
      emailEventId: "ev-card",
      amountCents: 2000,
      reviewStatus: "needs_review",
      eventKind: "purchase",
    });
    const plan = decide(
      venmoCtx({ account: VENMO_K, accounts: [CARD, CHECKING, VENMO_D, VENMO_K], alert: paid(), candidates: [waiting] }),
    );
    expect(plan.action).toBe("create");
    if (plan.action !== "create") return;
    expect(plan.transactions.map((t) => t.kind)).toEqual(["expense"]);
    expect(plan.updates).toEqual([{ id: "xfer-wait", transferTo: VENMO_K.id, reviewStatus: "confirmed" }]);
  });

  it("a Venmo cash-out is a transfer Venmo → bank, never Income", () => {
    const plan = decide(
      venmoCtx({
        alert: alert({ kind: "transfer", transferDirection: "out", merchantRaw: "Venmo transfer", accountHint: {}, amountCents: 5000, isPending: false, fundingSource: { last4: "1111" } }),
      }),
    );
    expect(plan.action === "create" && plan.transactions[0]).toMatchObject({
      kind: "transfer",
      transferFrom: VENMO_D.id,
      transferTo: CHECKING.id,
      description: "Venmo cash-out",
    });
  });

  it("the bank's deposit alert for that cash-out is a duplicate, not Income", () => {
    const cashout = row({
      id: "xfer-co",
      kind: "transfer",
      account: null,
      transferFrom: VENMO_D.id,
      transferTo: CHECKING.id,
      emailEventId: "ev-co",
      amountCents: 5000,
      reviewStatus: "confirmed",
      eventKind: "transfer",
    });
    const plan = decide(
      ctx({
        account: CHECKING,
        accounts: [CARD, CHECKING, VENMO_D],
        merchant: null,
        alert: alert({ kind: "payment_received", merchantRaw: "VENMO CASHOUT", accountHint: { last4: "1111" }, amountCents: 5000, isPending: false }),
        candidates: [cashout],
      }),
    );
    expect(plan).toMatchObject({ action: "duplicate", transactionId: "xfer-co" });
  });

  it("a hand-logged transfer is linked, not doubled", () => {
    const manual = row({
      id: "xfer-manual",
      kind: "transfer",
      source: "manual",
      account: null,
      transferFrom: CARD.id,
      transferTo: VENMO_D.id,
      emailEventId: null,
      amountCents: 2000,
      reviewStatus: "confirmed",
      eventKind: null,
      occurredAt: hours(-30),
    });
    const plan = decide(ctx({ alert: cardVenmo, accounts: [CARD, CHECKING, VENMO_D], merchant: null, candidates: [manual] }));
    expect(plan).toMatchObject({ action: "link", transactionId: "xfer-manual", update: { attachEvent: true } });
  });

  it("no Venmo account at all: the external label 'Venmo', confirmed", () => {
    const plan = decide(ctx({ alert: cardVenmo, merchant: null }));
    expect(plan.action === "create" && plan.transactions[0]).toMatchObject({
      transferTo: "Venmo",
      reviewStatus: "confirmed",
    });
  });
});

describe("isGasHold", () => {
  it("knows $1.00 and round $25 steps between $50 and $200", () => {
    expect([100, 5000, 7500, 12500, 20000].every((c) => isGasHold(c))).toBe(true);
    expect([4317, 4999, 25000, 2500, 6000].some((c) => isGasHold(c))).toBe(false);
  });
});
