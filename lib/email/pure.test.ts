import { describe, expect, it } from "vitest";
import { checkDkim, dkimPassDomains } from "@/lib/email/dkim";
import { localDate, resolveAlertOccurredAt } from "@/lib/email/occurredAt";
import { validateEmailPayload } from "@/lib/email/payload";
import { extractAddress, htmlToText, normalizeEmail, unwrapForwardedSender } from "@/lib/email/normalize";
import { decideCategory, ruleAfterAnswer, starterGuess, type MerchantRule } from "@/lib/email/rules";
import { findDate, findLast4, moneyToCents } from "@/lib/email/parsers/util";
import { matchIgnoreList } from "@/lib/email/ignoreList";
import { partId, partOf, wholeEmailId } from "@/lib/email/parts";
import { resolveAccount } from "@/lib/email/accountResolution";
import type { AccountRef } from "@/lib/email/decide";

describe("DKIM gate", () => {
  const good =
    "mx.google.com; dkim=pass header.i=@alerts.examplebank.com header.s=s1 header.b=abc; spf=pass smtp.mailfrom=x; dmarc=pass";
  it("finds pass domains", () => {
    expect(dkimPassDomains(good)).toEqual(["alerts.examplebank.com"]);
    expect(dkimPassDomains("mx.google.com; dkim=fail header.d=examplebank.com")).toEqual([]);
  });
  it("passes a subdomain of an allowed domain", () => {
    expect(checkDkim(good, "", ["examplebank.com"])).toMatchObject({ pass: true, via: "dkim" });
  });
  it("rejects a spoofed sender (DKIM for someone else's domain)", () => {
    const spoof = "mx.google.com; dkim=pass header.i=@gmail.com; spf=pass";
    expect(checkDkim(spoof, "", ["examplebank.com"]).pass).toBe(false);
  });
  it("rejects a verdict not stamped by Gmail", () => {
    expect(checkDkim("evil.example; dkim=pass header.d=examplebank.com", "", ["examplebank.com"]).pass).toBe(false);
  });
  it("accepts Gmail's ARC verdict only when arc=pass", () => {
    const top = "mx.google.com; dkim=fail; arc=pass (i=1); spf=pass";
    const arc = "i=1; mx.google.com; dkim=pass header.i=@examplebank.com";
    expect(checkDkim(top, arc, ["examplebank.com"])).toMatchObject({ pass: true, via: "arc" });
    expect(checkDkim(top.replace("arc=pass", "arc=fail"), arc, ["examplebank.com"]).pass).toBe(false);
  });
});

describe("occurredAt", () => {
  const tz = "America/Denver";
  it("uses the email's timestamp when the body date is the email's local date", () => {
    // 8:30pm in Denver on Nov 30 is already Dec 1 in UTC.
    const received = "2026-12-01T03:30:00.000Z";
    expect(localDate(received, tz)).toBe("2026-11-30");
    expect(
      resolveAlertOccurredAt({ occurredAt: null, occurredDate: "2026-11-30", emailReceivedAt: received, timeZone: tz }),
    ).toBe(received);
  });
  it("anchors a different date at 12:00 UTC so it stays in its month", () => {
    expect(
      resolveAlertOccurredAt({
        occurredAt: null,
        occurredDate: "2026-11-28",
        emailReceivedAt: "2026-12-01T03:30:00.000Z",
        timeZone: tz,
      }),
    ).toBe("2026-11-28T12:00:00.000Z");
  });
  it("prefers an exact time from the body", () => {
    expect(
      resolveAlertOccurredAt({
        occurredAt: "2026-11-28T18:01:00Z",
        occurredDate: null,
        emailReceivedAt: "2026-12-01T03:30:00.000Z",
        timeZone: tz,
      }),
    ).toBe("2026-11-28T18:01:00.000Z");
  });
});

describe("rules", () => {
  const m: MerchantRule = {
    id: "m",
    displayName: "McDonald's",
    mode: "ask_all",
    category: null,
    shortlist: [],
    defaultCategory: null,
  };
  it("a guess never creates a rule; only `always` does", () => {
    expect(ruleAfterAnswer({ ...m, defaultCategory: "Dates" }, { category: "Eating Out" })).toBeNull();
    expect(ruleAfterAnswer(m, { category: "Eating Out", always: true })).toMatchObject({
      mode: "auto",
      category: "Eating Out",
    });
  });
  it("the first answer becomes the default", () => {
    expect(ruleAfterAnswer(m, { category: "Dates" })).toMatchObject({ mode: "ask_all", defaultCategory: "Dates" });
  });
  it("add to shortlist switches the mode", () => {
    expect(ruleAfterAnswer(m, { category: "Dates", addToShortlist: true })).toMatchObject({
      mode: "ask_shortlist",
      shortlist: ["Dates"],
    });
  });
  it("people (Venmo) are never guessed and never get a remembered default", () => {
    const person = { person: true };
    // No default saved from an ordinary answer…
    expect(ruleAfterAnswer(m, { category: "Dates" }, person)).toBeNull();
    // …but the explicit choices still work, still without a default.
    expect(ruleAfterAnswer(m, { category: "Gifts", always: true }, person)).toMatchObject({
      mode: "auto",
      category: "Gifts",
      defaultCategory: null,
    });
    expect(ruleAfterAnswer(m, { category: "Gifts", addToShortlist: true }, person)).toMatchObject({
      mode: "ask_shortlist",
      shortlist: ["Gifts"],
      defaultCategory: null,
    });
    // An old default and a starter-guess-looking name are both ignored.
    expect(decideCategory({ ...m, defaultCategory: "Gas" }, "SHELL", person)).toMatchObject({
      reviewStatus: "needs_review",
      category: null,
      categorizedBy: null,
      choices: "all",
    });
    expect(decideCategory({ ...m, mode: "ask_shortlist", shortlist: ["Gifts"], defaultCategory: "Gifts" }, "X", person))
      .toMatchObject({ category: null, choices: ["Gifts"] });
    // "Always file <name> this way" still files automatically.
    expect(decideCategory({ ...m, mode: "auto", category: "Gifts" }, "X", person)).toMatchObject({
      reviewStatus: "confirmed",
      category: "Gifts",
    });
  });
  it("rejects categories that don't exist", () => {
    expect(ruleAfterAnswer(m, { category: "Snacks", always: true })).toBeNull();
    expect(decideCategory({ ...m, mode: "auto", category: "Snacks" }, "X").reviewStatus).toBe("needs_review");
  });
  it("starter guesses match whole words only", () => {
    expect(starterGuess("SMITHS FOOD")).toBe("Groceries");
    expect(starterGuess("SHELLY BOUTIQUE")).toBeNull();
  });
});

describe("parser helpers", () => {
  it("parses money into integer cents", () => {
    expect(moneyToCents("$1,234.56")).toBe(123456);
    expect(moneyToCents("$14.8")).toBe(1480);
    expect(moneyToCents("USD 12")).toBe(1200);
    expect(moneyToCents("nothing")).toBeNull();
  });
  it("finds exactly one last-4", () => {
    expect(findLast4("Card ending in 4821")).toBe("4821");
    expect(findLast4("account ••1234")).toBe("1234");
    expect(findLast4("ending in 1111 and ending in 2222")).toBeNull();
  });
  it("reads dates", () => {
    expect(findDate("on Nov 15, 2026 at 3pm")).toBe("2026-11-15");
    expect(findDate("11/15/26")).toBe("2026-11-15");
    expect(findDate("02/30/2026")).toBeNull();
  });
});

describe("payload + normalize", () => {
  const base = {
    gmailMessageId: "18c2f0a1b2c3d4e5",
    from: "Alerts <alerts@examplebank.com>",
    to: "stash.inbox@gmail.com",
    subject: "A charge",
    date: "2026-11-15T18:00:00Z",
    plainBody: "",
    htmlBody: "<p>Amount: <b>$12.40</b></p><p>Merchant&nbsp;McDonald&#39;s</p>",
    headers: { "X-Forwarded-For": "Daniel <daniel@example.com>" },
  };
  it("validates and normalizes", () => {
    const p = validateEmailPayload(base);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    const email = normalizeEmail(p);
    expect(email.from).toBe("alerts@examplebank.com");
    expect(email.forwardedFor).toBe("daniel@example.com");
    expect(email.text).toBe("Amount: $12.40\nMerchant McDonald's");
  });
  it("rejects bodies with no message id, a bad date or no body", () => {
    expect(validateEmailPayload({ ...base, gmailMessageId: "" })).toHaveProperty("error");
    expect(validateEmailPayload({ ...base, date: "yesterday" })).toHaveProperty("error");
    expect(validateEmailPayload({ ...base, htmlBody: "" })).toHaveProperty("error");
    expect(validateEmailPayload([1])).toHaveProperty("error");
  });
  it("extracts addresses and unwraps hand-forwards", () => {
    expect(extractAddress("Chase <No.Reply@Chase.com>")).toBe("no.reply@chase.com");
    expect(
      unwrapForwardedSender("hi\n---------- Forwarded message ---------\nFrom: Bank <alerts@examplebank.com>\nDate: x"),
    ).toBe("alerts@examplebank.com");
  });
  it("flattens html tables line by line", () => {
    expect(htmlToText("<table><tr><td>A</td><td>$1.00</td></tr><tr><td>B</td></tr></table>")).toBe("A $1.00\nB");
  });
  it("ignore-lists Gmail and Apps Script notices", () => {
    const p = validateEmailPayload({ ...base, from: "forwarding-noreply@google.com", subject: "Gmail Forwarding Confirmation" });
    if ("error" in p) throw new Error(p.error);
    expect(matchIgnoreList(normalizeEmail(p))?.reason).toBe("gmail_forwarding_confirmation");
    const q = validateEmailPayload({
      ...base,
      from: "apps-scripts-notifications@google.com",
      subject: "Summary of failures for Google Apps Script: Stash poller",
    });
    if ("error" in q) throw new Error(q.error);
    expect(matchIgnoreList(normalizeEmail(q))).toMatchObject({ reason: "apps_script_failure", raisesWarning: true });
  });
  it("ignores Google's own welcome and offer mail to the Stash inbox, never a gmail.com forward", () => {
    for (const from of ["Google Photos <noreply-photos@google.com>", "voice-noreply@google.com", "googlecommunityteam-noreply@google.com"]) {
      const p = validateEmailPayload({ ...base, from, subject: "Welcome" });
      if ("error" in p) throw new Error(p.error);
      expect(matchIgnoreList(normalizeEmail(p)), from).toMatchObject({ reason: "google_account_notice", raisesWarning: false });
    }
    const fwd = validateEmailPayload({ ...base, from: "someone@gmail.com", subject: "Fwd: A new transaction was charged" });
    if ("error" in fwd) throw new Error(fwd.error);
    expect(matchIgnoreList(normalizeEmail(fwd))).toBeNull();
  });
});

describe("parts of one email (lib/email/parts.ts)", () => {
  it("numbers parts from 1 and finds the whole email again", () => {
    expect(partId("18c0ffee", 2)).toBe("18c0ffee#2");
    expect(partOf("18c0ffee#2")).toBe(2);
    expect(partOf("18c0ffee")).toBeNull();
    expect(partOf("18c0ffee#0")).toBeNull();
    expect(partOf("18c0ffee#51")).toBeNull();
    expect(wholeEmailId("18c0ffee#12")).toBe("18c0ffee");
    expect(wholeEmailId("18c0ffee")).toBe("18c0ffee");
  });
  const payload = (gmailMessageId: string) => ({
    gmailMessageId,
    from: "Bank <alerts@examplebank.com>",
    to: "stash.inbox@example.com",
    subject: "Alert",
    date: "2026-11-19T12:00:00Z",
    plainBody: "hello",
    htmlBody: "",
    headers: {},
  });
  it("normalizeEmail carries the id the parser reads its part from", () => {
    const p = validateEmailPayload(payload("18c0ffee"));
    if ("error" in p) throw new Error(p.error);
    expect(normalizeEmail({ ...p, gmailMessageId: partId(p.gmailMessageId, 3) }).gmailMessageId).toBe("18c0ffee#3");
  });
  it("the poller can never post a part id, so a real email can't pose as one", () => {
    expect(validateEmailPayload(payload("18c0ffee#1"))).toHaveProperty("error");
  });
});

describe("account resolution (§5.4)", () => {
  const acct = (over: Partial<AccountRef>): AccountRef => ({
    id: "a",
    name: "A",
    kind: "credit_card",
    isDefault: false,
    alertSource: "examplebank",
    alertLast4: "4821",
    alertForwardedFrom: null,
    alertUnnumbered: false,
    unattendedAction: "keep_in_review",
    ...over,
  });
  const alertWith = (last4?: string) => ({
    kind: "purchase" as const,
    amountCents: 100,
    merchantRaw: "X",
    accountHint: last4 ? { last4 } : {},
    occurredAt: null,
    occurredDate: null,
    isPending: true,
  });
  it("matches source + last4", () => {
    const r = resolveAccount({ id: "examplebank", accountKey: "last4" }, alertWith("4821"), { forwardedFor: null, to: null }, [acct({})]);
    expect(r.account?.id).toBe("a");
  });
  it("never falls back to the only account for that bank", () => {
    const r = resolveAccount({ id: "examplebank", accountKey: "last4" }, alertWith("0000"), { forwardedFor: null, to: null }, [acct({})]);
    expect(r).toMatchObject({ account: null, reason: "no_matching_account", key: { last4: "0000" } });
  });
  it("resolves Venmo by whose inbox forwarded it", () => {
    const venmo = acct({ id: "v", alertSource: "venmo", alertLast4: null, alertForwardedFrom: "katie@example.com" });
    const r = resolveAccount(
      { id: "venmo", accountKey: "forwarded_from" },
      alertWith(),
      { forwardedFor: "Katie@Example.com", to: "stash@gmail.com" },
      [venmo],
    );
    expect(r.account?.id).toBe("v");
  });
});

describe("alerts that name no account (Bill Pay, migration 008)", () => {
  const acct = (over: Partial<AccountRef>): AccountRef => ({
    id: "a",
    name: "A",
    kind: "checking",
    isDefault: false,
    alertSource: "wellsfargo",
    alertLast4: "1111",
    alertForwardedFrom: null,
    alertUnnumbered: false,
    unattendedAction: "keep_in_review",
    ...over,
  });
  const billPay = {
    kind: "payment_sent" as const,
    amountCents: 75000,
    merchantRaw: "Example Property Co",
    accountHint: {},
    occurredAt: null,
    occurredDate: null,
    isPending: false,
  };
  const wf = { id: "wellsfargo", accountKey: "last4" as const, unnumbered: { label: "Bill Pay" } };
  const email = { forwardedFor: null, to: null };

  it("goes to the account ticked for them", () => {
    const r = resolveAccount(wf, billPay, email, [acct({}), acct({ id: "b", alertLast4: "2222", alertUnnumbered: true })]);
    expect(r).toMatchObject({ account: { id: "b" }, key: { unnumbered: true } });
  });
  it("waits under Unknown account when none is ticked — never the only account", () => {
    const r = resolveAccount(wf, billPay, email, [acct({})]);
    expect(r).toMatchObject({ account: null, reason: "no_matching_account", key: { unnumbered: true } });
  });
  it("a parser without such alerts still needs a last four", () => {
    const r = resolveAccount({ id: "wellsfargo", accountKey: "last4" }, billPay, email, [acct({ alertUnnumbered: true })]);
    expect(r).toMatchObject({ account: null, reason: "no_last4" });
  });
  it("another bank's ticked account doesn't count", () => {
    const r = resolveAccount(wf, billPay, email, [acct({ alertSource: "examplebank", alertUnnumbered: true })]);
    expect(r.account).toBeNull();
  });
});
