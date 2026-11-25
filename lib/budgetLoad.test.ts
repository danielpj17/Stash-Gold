import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyBudgetResponse, loadBudgets, type BudgetLoadOutcome } from "@/lib/budgetLoad";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const html = (status: number) => new Response("<html>Gateway Timeout</html>", { status });
const networkError = () => Promise.reject(new TypeError("Failed to fetch"));

const BUDGETS = { "3": { Groceries: 400 } };

/** A fetch that answers from `script` in order, then repeats the last entry. */
function scriptedFetch(script: Array<() => Promise<Response> | Response>) {
  let i = 0;
  return vi.fn(async () => {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    return step();
  });
}

describe("classifyBudgetResponse", () => {
  it("accepts a budgets object", () => {
    expect(classifyBudgetResponse({ ok: true, status: 200 }, BUDGETS)).toEqual({ kind: "ok", budgets: BUDGETS });
    expect(classifyBudgetResponse({ ok: true, status: 200 }, {})).toEqual({ kind: "ok", budgets: {} });
  });

  it("treats a non-JSON body as unreachable", () => {
    expect(classifyBudgetResponse({ ok: false, status: 504 }, null)).toEqual({ kind: "unreachable" });
    expect(classifyBudgetResponse({ ok: true, status: 200 }, null)).toEqual({ kind: "unreachable" });
  });

  it("never retries a 401, JSON or not", () => {
    expect(classifyBudgetResponse({ ok: false, status: 401 }, { error: "Unauthorized" })).toEqual({
      kind: "rejected",
      error: "Unauthorized",
    });
    expect(classifyBudgetResponse({ ok: false, status: 401 }, null)).toEqual({ kind: "rejected", error: null });
  });

  it("passes a server's { error } string through", () => {
    expect(classifyBudgetResponse({ ok: false, status: 502 }, { error: "Neon timeout" })).toEqual({
      kind: "rejected",
      error: "Neon timeout",
    });
  });

  it("rejects other non-budget shapes without retrying", () => {
    expect(classifyBudgetResponse({ ok: true, status: 200 }, [])).toEqual({ kind: "rejected", error: null });
    expect(classifyBudgetResponse({ ok: false, status: 500 }, {})).toEqual({ kind: "rejected", error: null });
    expect(classifyBudgetResponse({ ok: true, status: 200 }, { error: { code: 1 } })).toEqual({
      kind: "rejected",
      error: null,
    });
  });
});

describe("loadBudgets", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("succeeds on the first try without waiting", async () => {
    const fetchImpl = scriptedFetch([() => json(BUDGETS)]);
    const onDone = vi.fn<(o: BudgetLoadOutcome) => void>();
    loadBudgets(onDone, { fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith({ kind: "ok", budgets: BUDGETS });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a network error after ~1s, then ~4s, and recovers", async () => {
    const fetchImpl = scriptedFetch([networkError, () => html(504), () => json(BUDGETS)]);
    const onDone = vi.fn<(o: BudgetLoadOutcome) => void>();
    loadBudgets(onDone, { fetchImpl });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith({ kind: "ok", budgets: BUDGETS });
  });

  it("gives up as unreachable after two retries", async () => {
    const fetchImpl = scriptedFetch([networkError]);
    const onDone = vi.fn<(o: BudgetLoadOutcome) => void>();
    loadBudgets(onDone, { fetchImpl });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith({ kind: "unreachable" });
  });

  it("does not retry a 401 or a JSON { error }", async () => {
    for (const response of [() => json({ error: "Unauthorized" }, 401), () => json({ error: "boom" }, 502)]) {
      const fetchImpl = scriptedFetch([response]);
      const onDone = vi.fn<(o: BudgetLoadOutcome) => void>();
      loadBudgets(onDone, { fetchImpl });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledOnce();
      expect(onDone.mock.calls[0][0].kind).toBe("rejected");
    }
  });

  it("cancelling during a pending retry stops it and never reports", async () => {
    const fetchImpl = scriptedFetch([networkError, () => json(BUDGETS)]);
    const onDone = vi.fn<(o: BudgetLoadOutcome) => void>();
    const cancel = loadBudgets(onDone, { fetchImpl });
    await vi.advanceTimersByTimeAsync(500);
    cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("cancelling while a request is in flight drops its answer", async () => {
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const onDone = vi.fn<(o: BudgetLoadOutcome) => void>();
    const cancel = loadBudgets(onDone, { fetchImpl });
    cancel();
    resolve(json(BUDGETS));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onDone).not.toHaveBeenCalled();
  });
});
