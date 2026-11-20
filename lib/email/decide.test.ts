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
  alertUnnumbered: false,
  paymentsFrom: null,
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

  it("a card payment is never income: it is a transfer into the card", () => {
    const plan = decide(
      ctx({ alert: alert({ kind: "transfer", transferDirection: "in", merchantRaw: "PAYMENT THANK YOU", isPending: false }) }),
    );
    expect(plan).toMatchObject({ action: "create", reason: "transfer_side_unknown" });
    if (plan.action !== "create") return;
    expect(plan.transactions).toHaveLength(1);
    expect(plan.transactions[0]).toMatchObject({
      kind: "transfer",
      category: null,
      transferFrom: null,
      transferTo: CARD.id,
      reviewStatus: "needs_review",
      description: "Card payment",
    });
    expect(plan.notify).toBe(false);
  });

  it("with account transfers switched off, a card payment is ignored as before", () => {
    const plan = decide(
      ctx({
        alert: alert({ kind: "transfer", transferDirection: "in", merchantRaw: "PAYMENT THANK YOU", isPending: false }),
        config: { enableAccountTransfers: false },
      }),
    );
    expect(plan).toMatchObject({ action: "ignore", reason: "transfer_not_tracked" });
  });

  describe("Venmo 'X paid you' is a transfer from Other into that Venmo, not Income", () => {
    const paid = (over: Partial<ParsedAlert> = {}) =>
      alert({ kind: "payment_received", merchantRaw: "Alex Smith", counterparty: "Alex Smith", memo: "pizza", accountHint: {}, isPending: false, amountCents: 1500, ...over });
    const venmoCtx = (over: Partial<DecideContext> = {}) =>
      ctx({
        parser: { id: "venmo", accountKey: "forwarded_from" },
        account: VENMO_D,
        accounts: [CARD, CHECKING, VENMO_D],
        merchant: null,
        alert: paid(),
        ...over,
      });

    it("creates Other → Venmo, confirmed, described by the note, no question", () => {
      const plan = decide(venmoCtx());
      expect(plan).toMatchObject({ action: "create", reason: "venmo_received", notify: false });
      if (plan.action !== "create") return;
      expect(plan.transactions).toEqual([
        expect.objectContaining({
          kind: "transfer",
          category: null,
          account: null,
          transferFrom: "Other",
          transferTo: VENMO_D.id,
          reviewStatus: "confirmed",
          description: "pizza",
        }),
      ]);
    });

    it("never pairs with another person's payment of the same amount", () => {
      const sams = row({
        kind: "transfer",
        account: null,
        amountCents: 1500,
        transferFrom: "Other",
        transferTo: VENMO_D.id,
        reviewStatus: "confirmed",
        eventKind: "payment_received",
        eventMerchantKey: merchantKey("Sam Lee"),
      });
      const plan = decide(venmoCtx({ candidates: [sams] }));
      expect(plan).toMatchObject({ action: "create", reason: "venmo_received" });
    });

    it("the same receipt from the other inbox is a duplicate", () => {
      const first = row({
        kind: "transfer",
        account: null,
        amountCents: 1500,
        transferFrom: "Other",
        transferTo: VENMO_D.id,
        reviewStatus: "confirmed",
        eventKind: "payment_received",
        eventMerchantKey: merchantKey("Alex Smith"),
        eventForwardedFor: "katie@example.com",
      });
      expect(decide(venmoCtx({ candidates: [first] }))).toMatchObject({ action: "duplicate", reason: "same_alert" });
    });

    it("links to a transfer you already logged by hand", () => {
      const manual = row({
        id: "tx-manual",
        kind: "transfer",
        source: "manual",
        emailEventId: null,
        account: null,
        amountCents: 1500,
        transferFrom: "Other",
        transferTo: VENMO_D.id,
        reviewStatus: "confirmed",
        eventKind: null,
        eventMerchantKey: null,
      });
      expect(decide(venmoCtx({ candidates: [manual] }))).toMatchObject({
        action: "link",
        reason: "matched_manual_transfer",
        transactionId: "tx-manual",
      });
    });

    it("no note: says who it was from", () => {
      const plan = decide(venmoCtx({ alert: paid({ memo: undefined }) }));
      if (plan.action !== "create") throw new Error(plan.action);
      expect(plan.transactions[0].description).toBe("Venmo from Alex Smith");
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

  describe("deposits are named by their source", () => {
    const deposit = (over: Partial<DecideContext> = {}) =>
      decide(
        ctx({
          account: CHECKING,
          merchant: null,
          alert: alert({ kind: "payment_received", merchantRaw: "EXAMPLE EMPLOYER PAYROLL", accountHint: { last4: "1111" }, amountCents: 123456, isPending: false }),
          ...over,
        }),
      );

    it("a new source: Income, confirmed, no push, its raw name, and a merchant to rename", () => {
      const plan = deposit();
      if (plan.action !== "create") throw new Error(plan.action);
      expect(plan.transactions[0]).toMatchObject({
        kind: "income",
        category: "Income",
        amountCents: 123456,
        account: CHECKING.id,
        description: "Example Employer Payroll",
        reviewStatus: "confirmed",
        attachMerchant: true,
      });
      expect(plan.notify).toBe(false);
    });

    it("a source renamed under Rules → Money in gives just that name", () => {
      const plan = deposit({ merchant: { ...MCD, id: "m-pay", displayName: "Acme", mode: "ask_all", shortlist: [], defaultCategory: null } });
      if (plan.action !== "create") throw new Error(plan.action);
      expect(plan.transactions[0].description).toBe("Acme");
      // A merchant's category settings never touch money in.
      expect(plan.transactions[0].category).toBe("Income");
    });

    it("a source with an expense-style rule is still Income", () => {
      const plan = deposit({ merchant: { ...MCD, mode: "auto", category: "Groceries" } });
      if (plan.action !== "create") throw new Error(plan.action);
      expect(plan.transactions[0]).toMatchObject({ kind: "income", category: "Income", reviewStatus: "confirmed" });
    });

    it("a refund keeps its prefix and doesn't become a merchant of its own", () => {
      const plan = decide(ctx({ alert: alert({ kind: "refund", isPending: false }) }));
      if (plan.action !== "create") throw new Error(plan.action);
      expect(plan.transactions[0]).toMatchObject({ kind: "income", description: "Refund · McDonald's", attachMerchant: false });
    });
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

  it("a Venmo payment is never guessed, even when the person has an old default", () => {
    const friend: MerchantRule = { id: "m-alex", displayName: "Alex Smith", mode: "ask_all", category: null, shortlist: [], defaultCategory: "Gas" };
    const plan = decide(venmoCtx({ alert: paid(), merchant: friend }));
    expect(plan.action === "create" && plan.transactions[0]).toMatchObject({
      kind: "expense",
      reviewStatus: "needs_review",
      category: null,
    });
    const always = decide(venmoCtx({ alert: paid(), merchant: { ...friend, mode: "auto", category: "Gifts" } }));
    expect(always.action === "create" && always.transactions[0]).toMatchObject({ reviewStatus: "confirmed", category: "Gifts" });
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

describe("card payments and transfers between your own accounts", () => {
  const WF_CHECKING: AccountRef = {
    ...CARD,
    id: "acct-wf-checking",
    name: "WF Checking",
    kind: "checking",
    alertSource: "wellsfargo",
    alertLast4: "1111",
    alertUnnumbered: true,
  };
  const WF_CARD: AccountRef = { ...WF_CHECKING, id: "acct-wf-card", name: "WF Card", kind: "credit_card", alertLast4: "2222", alertUnnumbered: false };
  const WF_SAVINGS: AccountRef = { ...WF_CHECKING, id: "acct-wf-savings", name: "WF Savings", kind: "savings", alertLast4: "3333", alertUnnumbered: false };
  const ACCOUNTS = [WF_CHECKING, WF_CARD, WF_SAVINGS, CARD];

  const payment = (over: Partial<ParsedAlert> = {}) =>
    alert({
      kind: "transfer",
      transferDirection: "out",
      amountCents: 12345,
      merchantRaw: "Wells Fargo payment",
      accountHint: { last4: "1111" },
      fundingSource: { last4: "2222" },
      isPending: false,
      ...over,
    });
  const wf = (a: ParsedAlert, over: Partial<DecideContext> = {}) =>
    ctx({
      parser: { id: "wellsfargo", accountKey: "last4" },
      account: WF_CHECKING,
      accounts: ACCOUNTS,
      merchant: null,
      alert: a,
      ...over,
    });
  const transferRow = (over: Partial<CandidateRow> = {}) =>
    row({
      id: "tx-transfer",
      kind: "transfer",
      amountCents: 12345,
      account: null,
      transferFrom: WF_CHECKING.id,
      transferTo: WF_CARD.id,
      reviewStatus: "confirmed",
      isPending: false,
      merchantId: null,
      eventKind: "transfer",
      eventMerchantKey: merchantKey("Wells Fargo payment"),
      ...over,
    });

  it("an email naming both accounts creates one complete transfer", () => {
    const plan = decide(wf(payment()));
    expect(plan).toMatchObject({ action: "create", reason: "account_transfer", notify: false });
    if (plan.action !== "create") return;
    expect(plan.transactions).toEqual([
      expect.objectContaining({
        kind: "transfer",
        amountCents: 12345,
        category: null,
        account: null,
        transferFrom: WF_CHECKING.id,
        transferTo: WF_CARD.id,
        reviewStatus: "confirmed",
        description: "Card payment",
        attachMerchant: false,
        attachEvent: true,
      }),
    ]);
  });

  it("checking → savings is described as a transfer", () => {
    const plan = decide(wf(payment({ merchantRaw: "Wells Fargo online transfer", fundingSource: { last4: "3333" } })));
    if (plan.action !== "create") throw new Error(plan.action);
    expect(plan.transactions[0]).toMatchObject({ transferTo: WF_SAVINGS.id, description: "Transfer" });
  });

  it("links to the transfer you already logged by hand instead of adding a second", () => {
    const manual = transferRow({ source: "manual", emailEventId: null, eventKind: null, eventMerchantKey: null, occurredAt: hours(-30) });
    const plan = decide(wf(payment(), { candidates: [manual] }));
    expect(plan).toMatchObject({
      action: "link",
      reason: "matched_manual_transfer",
      transactionId: manual.id,
      update: { id: manual.id, attachEvent: true },
    });
  });

  it("the card's own 'payment received' after the bank's email is the same transfer", () => {
    const fromBank = transferRow();
    const cardSide = alert({
      kind: "transfer",
      transferDirection: "in",
      amountCents: 12345,
      merchantRaw: "PAYMENT THANK YOU",
      accountHint: { last4: "2222" },
      isPending: false,
    });
    const plan = decide(wf(cardSide, { account: WF_CARD, candidates: [fromBank], occurredAt: hours(40) }));
    expect(plan).toMatchObject({ action: "duplicate", reason: "transfer_already_recorded", transactionId: fromBank.id });
  });

  it("the card's email first leaves 'from' unknown; the bank's email fills it in", () => {
    const waiting = transferRow({
      transferFrom: null,
      reviewStatus: "needs_review",
      eventMerchantKey: merchantKey("PAYMENT THANK YOU"),
    });
    const plan = decide(wf(payment(), { candidates: [waiting], occurredAt: hours(24) }));
    expect(plan).toMatchObject({
      action: "link",
      reason: "completed_transfer_side",
      transactionId: waiting.id,
      update: { id: waiting.id, transferFrom: WF_CHECKING.id, reviewStatus: "confirmed" },
    });
  });

  it("two emails of the same type are two transfers, not a duplicate", () => {
    const earlier = transferRow({ occurredAt: hours(-24), eventBodySha256: "sha-earlier" });
    const plan = decide(wf(payment(), { candidates: [earlier] }));
    expect(plan).toMatchObject({ action: "create", reason: "account_transfer" });
  });

  it("…unless it is the same email again", () => {
    const same = transferRow({ eventBodySha256: "sha-new" });
    const plan = decide(wf(payment(), { candidates: [same] }));
    expect(plan).toMatchObject({ action: "duplicate", reason: "transfer_already_recorded" });
  });

  it("an account Stash doesn't know waits as 'Which account?', never a guess", () => {
    const plan = decide(wf(payment({ fundingSource: { last4: "9876" } })));
    expect(plan).toMatchObject({ action: "create", reason: "transfer_side_unknown", notify: false });
    if (plan.action !== "create") return;
    expect(plan.transactions[0]).toMatchObject({ transferFrom: WF_CHECKING.id, transferTo: null, reviewStatus: "needs_review" });
  });

  it("an email naming the same account twice is not a transfer", () => {
    const plan = decide(wf(payment({ fundingSource: { last4: "1111" } })));
    expect(plan).toMatchObject({ action: "ignore", reason: "transfer_same_account" });
  });

  it("prefers this bank's own account when two accounts share a last four", () => {
    const otherBank: AccountRef = { ...CARD, id: "acct-other-2222", alertSource: "examplebank", alertLast4: "2222" };
    const plan = decide(wf(payment(), { accounts: [...ACCOUNTS, otherBank] }));
    if (plan.action !== "create") throw new Error(plan.action);
    expect(plan.transactions[0]).toMatchObject({ transferTo: WF_CARD.id, reviewStatus: "confirmed" });
  });

  it("a Bill Pay payment is an ordinary expense, asked like any purchase", () => {
    const plan = decide(
      wf(
        alert({
          kind: "payment_sent",
          amountCents: 75000,
          merchantRaw: "Example Property Co",
          accountHint: {},
          isPending: false,
        }),
      ),
    );
    expect(plan).toMatchObject({ action: "create", reason: "ask", notify: true });
    if (plan.action !== "create") return;
    expect(plan.transactions[0]).toMatchObject({ kind: "expense", account: WF_CHECKING.id, isPending: false });
  });
});

describe("posted-activity summary lines (Wells Fargo account update)", () => {
  const CHK: AccountRef = { ...CARD, id: "acct-wf-checking", name: "WF Checking", kind: "checking", alertSource: "wellsfargo", alertLast4: "1111" };
  const C1: AccountRef = { ...CARD, id: "acct-c1", name: "Capital One", kind: "credit_card", alertSource: "capitalone", alertLast4: "4444" };
  const ACCTS = [CHK, C1, CARD];
  const SUMMARY_ID = "gm-summary";

  const line = (over: Partial<ParsedAlert> = {}) =>
    alert({
      kind: "posted",
      amountCents: 7636,
      merchantRaw: "Ch Example DONATION",
      accountHint: { last4: "1111" },
      isPending: false,
      postedSummary: true,
      ...over,
    });
  const at = (a: ParsedAlert, over: Partial<DecideContext> = {}, part = 1) =>
    ctx({
      parser: { id: "wellsfargo", accountKey: "last4" },
      account: CHK,
      accounts: ACCTS,
      defaultAccountId: CARD.id,
      merchant: null,
      alert: a,
      event: { id: `ev-${part}`, gmailMessageId: `${SUMMARY_ID}#${part}`, bodySha256: `sha-${part}`, forwardedFor: null, receivedAt: T0 },
      ...over,
    });
  const cardPayment = line({ kind: "transfer", transferDirection: "out", amountCents: 1070, merchantRaw: "CAPITAL ONE ONLINE PMT" });
  const transfer = (over: Partial<CandidateRow> = {}) =>
    row({
      id: "tx-pay",
      kind: "transfer",
      amountCents: 1070,
      account: null,
      transferFrom: CHK.id,
      transferTo: C1.id,
      reviewStatus: "confirmed",
      isPending: false,
      merchantId: null,
      occurredAt: hours(-24),
      ...over,
    });

  it("a card payment you logged by hand: links to it, no second transfer", () => {
    const plan = decide(at(cardPayment, { candidates: [transfer({ source: "manual", emailEventId: null, eventKind: null, eventMerchantKey: null })] }));
    expect(plan).toMatchObject({ action: "link", reason: "matched_manual_transfer", transactionId: "tx-pay" });
  });

  it("a card payment another email already recorded: duplicate", () => {
    const plan = decide(at(cardPayment, { candidates: [transfer({ source: "email", emailEventId: "ev-c1", eventGmailMessageId: "gm-c1" })] }));
    expect(plan).toMatchObject({ action: "duplicate", reason: "already_recorded", transactionId: "tx-pay" });
  });

  it("completes the card's own payment email, which named no paying account", () => {
    const waiting = transfer({ transferFrom: null, reviewStatus: "needs_review", source: "email", emailEventId: "ev-c1", eventGmailMessageId: "gm-c1" });
    const plan = decide(at(cardPayment, { candidates: [waiting] }));
    expect(plan).toMatchObject({
      action: "link",
      reason: "completed_transfer_side",
      transactionId: "tx-pay",
      update: { id: "tx-pay", transferFrom: CHK.id, reviewStatus: "confirmed" },
    });
  });

  it("a card payment nothing has recorded: a transfer from checking that asks which card", () => {
    const plan = decide(at(cardPayment));
    expect(plan).toMatchObject({ action: "create", reason: "transfer_side_unknown" });
    if (plan.action !== "create") return;
    expect(plan.transactions[0]).toMatchObject({ kind: "transfer", transferFrom: CHK.id, transferTo: null, description: "Card payment", reviewStatus: "needs_review" });
  });

  it("a donation nothing has recorded: an expense on checking that asks for a category", () => {
    const plan = decide(at(line()));
    expect(plan).toMatchObject({ action: "create", reason: "ask", notify: true });
    if (plan.action !== "create") return;
    expect(plan.transactions[0]).toMatchObject({ kind: "expense", account: CHK.id, amountCents: 7636, isPending: false });
  });

  it("a Bill Pay (or any expense) already on checking: duplicate, whatever its name", () => {
    const billPay = row({ id: "tx-bill", account: CHK.id, amountCents: 7636, isPending: false, source: "email", emailEventId: "ev-bill", eventGmailMessageId: "gm-bill", occurredAt: hours(-48) });
    expect(decide(at(line(), { candidates: [billPay] }))).toMatchObject({ action: "duplicate", reason: "already_recorded", transactionId: "tx-bill" });
  });

  it("logged by hand on the default account: links, as a hand entry would", () => {
    const manual = row({ id: "tx-hand", account: CARD.id, amountCents: 7636, isPending: false, source: "manual", emailEventId: null, eventKind: null, eventMerchantKey: null, eventGmailMessageId: null });
    expect(decide(at(line(), { candidates: [manual] }))).toMatchObject({ action: "link", transactionId: "tx-hand" });
  });

  it("the same amount on ANOTHER account (not a hand entry) doesn't count", () => {
    const elsewhere = row({ id: "tx-other", account: C1.id, amountCents: 7636, isPending: false, source: "email", emailEventId: "ev-x", eventGmailMessageId: "gm-x" });
    expect(decide(at(line(), { candidates: [elsewhere] }))).toMatchObject({ action: "create" });
  });

  it("too far apart in time doesn't count", () => {
    const old = row({ id: "tx-old", account: CHK.id, amountCents: 7636, isPending: false, source: "email", emailEventId: "ev-old", eventGmailMessageId: "gm-old", occurredAt: hours(-24 * 8) });
    expect(decide(at(line(), { candidates: [old] }))).toMatchObject({ action: "create" });
  });

  it("a paycheck the deposit alert recorded: duplicate", () => {
    const pay = row({ id: "tx-pay-in", kind: "income", category: "Income", account: CHK.id, amountCents: 30000, reviewStatus: "confirmed", isPending: false, source: "email", emailEventId: "ev-dep", eventGmailMessageId: "gm-dep" });
    const plan = decide(at(line({ kind: "payment_received", amountCents: 30000, merchantRaw: "EXAMPLE EMPLOYER PAYROLL" }), { candidates: [pay] }));
    expect(plan).toMatchObject({ action: "duplicate", reason: "already_recorded" });
  });

  it("money in never matches money out of the same amount", () => {
    const spent = row({ id: "tx-spent", account: CHK.id, amountCents: 30000, isPending: false, source: "email", emailEventId: "ev-s", eventGmailMessageId: "gm-s" });
    const plan = decide(at(line({ kind: "payment_received", amountCents: 30000, merchantRaw: "EXAMPLE EMPLOYER PAYROLL" }), { candidates: [spent] }));
    expect(plan).toMatchObject({ action: "create", reason: "money_in_as_income" });
  });

  it("rewards nothing has recorded: a confirmed transfer from Other, named by source", () => {
    const plan = decide(at(line({ kind: "transfer", transferDirection: "in", externalFrom: "Other", amountCents: 8677, merchantRaw: "WELLS FARGO REWARDS" })));
    expect(plan).toMatchObject({ action: "create", reason: "account_transfer", notify: false });
    if (plan.action !== "create") return;
    expect(plan.transactions[0]).toMatchObject({ kind: "transfer", transferFrom: "Other", transferTo: CHK.id, reviewStatus: "confirmed", description: "Wells Fargo Rewards" });
  });

  it("rewards you logged by hand (Other → checking): links", () => {
    const hand = transfer({ id: "tx-rw", amountCents: 8677, transferFrom: "Other", transferTo: CHK.id, source: "manual", emailEventId: null, eventKind: null, eventMerchantKey: null, eventGmailMessageId: null });
    const plan = decide(at(line({ kind: "transfer", transferDirection: "in", externalFrom: "Other", amountCents: 8677, merchantRaw: "WELLS FARGO REWARDS" }), { candidates: [hand] }));
    expect(plan).toMatchObject({ action: "link", reason: "matched_manual_transfer", transactionId: "tx-rw" });
  });

  it("two identical lines of ONE summary are two items", () => {
    const sibling = row({ id: "tx-sib", account: CHK.id, amountCents: 7636, isPending: false, source: "email", emailEventId: "ev-1", eventGmailMessageId: `${SUMMARY_ID}#1` });
    expect(decide(at(line(), { candidates: [sibling] }, 2))).toMatchObject({ action: "create" });
  });

  it("an alert that isn't a summary line is untouched by this rule", () => {
    const billPay = row({ id: "tx-bill", account: CHK.id, amountCents: 7636, isPending: false, source: "email", emailEventId: "ev-bill", eventGmailMessageId: "gm-bill" });
    const plan = decide(at(line({ postedSummary: undefined, kind: "payment_sent" }), { candidates: [billPay] }));
    expect(plan).toMatchObject({ action: "create" });
  });
});
describe("a card payment's two halves pair in either order", () => {
  const CHK: AccountRef = { ...CARD, id: "acct-wf-checking", name: "WF Checking", kind: "checking", alertSource: "wellsfargo", alertLast4: "1111" };
  const C1: AccountRef = { ...CARD, id: "acct-c1", name: "Capital One", kind: "credit_card", alertSource: "capitalone", alertLast4: "4444" };
  const D: AccountRef = { ...C1, id: "acct-discover", name: "Discover", alertLast4: "7777" };
  const waitingFromBank = (over: Partial<CandidateRow> = {}) =>
    row({ id: "tx-half", kind: "transfer", amountCents: 1070, account: null, transferFrom: CHK.id, transferTo: null, reviewStatus: "needs_review", isPending: false, merchantId: null, source: "email", emailEventId: "ev-sum", eventGmailMessageId: "gm-sum#2", eventKind: "transfer", eventMerchantKey: merchantKey("CAPITAL ONE ONLINE PMT"), ...over });
  const cardEmail = alert({ kind: "transfer", transferDirection: "in", amountCents: 1070, merchantRaw: "Capital One payment", accountHint: { last4: "4444" }, isPending: false });
  const c1 = (over: Partial<DecideContext> = {}) =>
    ctx({ parser: { id: "capitalone", accountKey: "last4" }, account: C1, accounts: [CHK, C1, D, CARD], merchant: null, alert: cardEmail, ...over });

  it("the card's email after the bank's line completes it (no second transfer)", () => {
    expect(decide(c1({ candidates: [waitingFromBank()] }))).toMatchObject({
      action: "link",
      reason: "completed_transfer_side",
      transactionId: "tx-half",
      update: { id: "tx-half", transferTo: C1.id, reviewStatus: "confirmed" },
    });
  });

  it("two waiting halves of that amount: never a guess between them", () => {
    const plan = decide(c1({ candidates: [waitingFromBank(), waitingFromBank({ id: "tx-half-2" })] }));
    expect(plan).toMatchObject({ action: "create", reason: "transfer_side_unknown" });
  });

  it("a different amount doesn't pair", () => {
    expect(decide(c1({ candidates: [waitingFromBank({ amountCents: 1071 })] }))).toMatchObject({ action: "create" });
  });

  it("only into a credit card: a checking → ? half never pairs with a savings deposit", () => {
    const SAV: AccountRef = { ...CHK, id: "acct-sav", name: "Savings", kind: "savings", alertLast4: "3333" };
    const plan = decide(c1({ account: SAV, accounts: [CHK, SAV, C1], parser: { id: "wellsfargo", accountKey: "last4" }, alert: { ...cardEmail, accountHint: { last4: "3333" } }, candidates: [waitingFromBank()] }));
    expect(plan).toMatchObject({ action: "create" });
  });
});
describe("a card's \"Payments come from\" (migration 009)", () => {
  const CHK: AccountRef = { ...CARD, id: "acct-wf-checking", name: "WF Checking", kind: "checking", alertSource: "wellsfargo", alertLast4: "1111" };
  const C1: AccountRef = { ...CARD, id: "acct-c1", name: "Capital One", kind: "credit_card", alertSource: "capitalone", alertLast4: "4444", paymentsFrom: CHK.id };
  const cardEmail = alert({ kind: "transfer", transferDirection: "in", amountCents: 1070, merchantRaw: "Capital One payment", accountHint: { last4: "4444" }, isPending: false });
  const c1 = (over: Partial<DecideContext> = {}) =>
    ctx({ parser: { id: "capitalone", accountKey: "last4" }, account: C1, accounts: [CHK, C1, CARD], merchant: null, alert: cardEmail, ...over });

  it("the card's email alone is a complete, confirmed transfer from the stated account", () => {
    const plan = decide(c1());
    expect(plan).toMatchObject({ action: "create", reason: "account_transfer", notify: false });
    if (plan.action !== "create") return;
    expect(plan.transactions[0]).toMatchObject({ kind: "transfer", transferFrom: CHK.id, transferTo: C1.id, reviewStatus: "confirmed", description: "Card payment" });
  });

  it("not set: still asks which account", () => {
    const plan = decide(c1({ account: { ...C1, paymentsFrom: null }, accounts: [CHK, { ...C1, paymentsFrom: null }, CARD] }));
    expect(plan).toMatchObject({ action: "create", reason: "transfer_side_unknown" });
  });

  it("set to an account that's since been deleted: asks, never a dead reference", () => {
    const gone = { ...C1, paymentsFrom: "acct-deleted" };
    expect(decide(c1({ account: gone, accounts: [CHK, gone, CARD] }))).toMatchObject({ action: "create", reason: "transfer_side_unknown" });
  });

  it("the bank's summary line already waiting (checking → ?): the card's email completes it", () => {
    const waiting = row({ id: "tx-half", kind: "transfer", amountCents: 1070, account: null, transferFrom: CHK.id, transferTo: null, reviewStatus: "needs_review", isPending: false, merchantId: null, source: "email", emailEventId: "ev-sum", eventGmailMessageId: "gm-sum#2", eventKind: "transfer", eventMerchantKey: merchantKey("CAPITAL ONE ONLINE PMT") });
    expect(decide(c1({ candidates: [waiting] }))).toMatchObject({ action: "link", transactionId: "tx-half", update: { transferTo: C1.id, reviewStatus: "confirmed" } });
  });

  it("only a card: a payment INTO checking never borrows a setting", () => {
    const chk = { ...CHK, paymentsFrom: C1.id };
    const plan = decide(c1({ account: chk, accounts: [chk, C1, CARD], parser: { id: "wellsfargo", accountKey: "last4" }, alert: { ...cardEmail, accountHint: { last4: "1111" } } }));
    expect(plan).toMatchObject({ action: "create", reason: "transfer_side_unknown" });
  });
});

describe("\"Don't record — I log these myself\" (merchant mode skip)", () => {
  const SKIP: MerchantRule = { id: "m-don", displayName: "Example Donation", mode: "skip", category: null, shortlist: [], defaultCategory: null };

  it("a card purchase for a skipped merchant records nothing", () => {
    expect(decide(ctx({ merchant: SKIP }))).toMatchObject({ action: "ignore", reason: "logged_by_hand" });
  });

  it("a summary line for it records nothing either, though nothing single matches", () => {
    const CHK: AccountRef = { ...CARD, id: "acct-wf-checking", kind: "checking", alertSource: "wellsfargo", alertLast4: "1111" };
    const pieces = [5000, 2000, 636].map((c, i) => row({ id: `tx-piece-${i}`, account: CHK.id, amountCents: c, isPending: false, source: "manual", emailEventId: null, eventKind: null, eventMerchantKey: null, eventGmailMessageId: null }));
    const plan = decide(
      ctx({
        parser: { id: "wellsfargo", accountKey: "last4" },
        account: CHK,
        accounts: [CHK, CARD],
        merchant: SKIP,
        alert: alert({ kind: "posted", amountCents: 7636, merchantRaw: "Ch Example DONATION", accountHint: { last4: "1111" }, isPending: false, postedSummary: true }),
        candidates: pieces,
      }),
    );
    expect(plan).toMatchObject({ action: "ignore", reason: "logged_by_hand" });
  });

  it("without the rule, the same split donation would be created (why the rule exists)", () => {
    const CHK: AccountRef = { ...CARD, id: "acct-wf-checking", kind: "checking", alertSource: "wellsfargo", alertLast4: "1111" };
    const plan = decide(
      ctx({
        parser: { id: "wellsfargo", accountKey: "last4" },
        account: CHK,
        accounts: [CHK, CARD],
        merchant: null,
        alert: alert({ kind: "posted", amountCents: 7636, merchantRaw: "Ch Example DONATION", accountHint: { last4: "1111" }, isPending: false, postedSummary: true }),
      }),
    );
    expect(plan).toMatchObject({ action: "create" });
  });
});