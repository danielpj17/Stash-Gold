import type { MonthlyBudgets } from "@/lib/budgetCategoryMigration";

/**
 * The dashboard's budget load, with the retry rule kept out of the component
 * so it can be tested.
 *
 * Two kinds of failure, and only one is worth retrying:
 *
 * - **unreachable** — the fetch threw (network drop, an iOS PWA resumed from
 *   the background, a Wi-Fi/cell handoff) or the body wasn't JSON (a gateway's
 *   HTML error page). Probably a blip: retried after ~1s, then ~4s.
 * - **rejected** — the server answered: a 401, or a JSON `{ error }`. Asking
 *   again won't change the answer, so it's final straight away.
 *
 * "ok" is the only outcome that carries budgets. Whatever the caller does with
 * a failure, it must not treat one as the stored budgets: saving PUTs the
 * whole store, so saving from a failed load would overwrite it.
 */
export type BudgetLoadOutcome =
  | { kind: "ok"; budgets: MonthlyBudgets }
  | { kind: "unreachable" }
  /** `error` is the server's own message, when it sent one. */
  | { kind: "rejected"; error: string | null };

/** One entry per retry; the length is the retry count. */
export const BUDGET_RETRY_DELAYS_MS: readonly number[] = [1000, 4000];

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `data` is the parsed body, or null when it wasn't JSON. */
export function classifyBudgetResponse(
  response: Pick<Response, "ok" | "status">,
  data: unknown,
): BudgetLoadOutcome {
  const errMsg =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as { error?: unknown }).error
      : undefined;
  const serverError = typeof errMsg === "string" ? errMsg : null;

  if (response.status === 401) return { kind: "rejected", error: serverError };
  if (data === null) return { kind: "unreachable" };
  if (serverError !== null) return { kind: "rejected", error: serverError };
  if (
    !response.ok ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    "error" in (data as Record<string, unknown>)
  ) {
    return { kind: "rejected", error: null };
  }
  return { kind: "ok", budgets: data as MonthlyBudgets };
}

async function attemptOnce(fetchImpl: FetchLike): Promise<BudgetLoadOutcome> {
  let response: Response;
  try {
    response = await fetchImpl("/api/budget", { cache: "no-store" });
  } catch {
    return { kind: "unreachable" };
  }
  // A body cut off mid-read by a network drop lands here as null too.
  const data: unknown = await response.json().catch(() => null);
  return classifyBudgetResponse(response, data);
}

/**
 * Starts a load and calls `onDone` once, with the final outcome. Returns a
 * cancel function for an effect's cleanup: it stops any pending retry, and
 * `onDone` never fires after it.
 */
export function loadBudgets(
  onDone: (outcome: BudgetLoadOutcome) => void,
  {
    fetchImpl = (input, init) => fetch(input, init),
    delaysMs = BUDGET_RETRY_DELAYS_MS,
  }: { fetchImpl?: FetchLike; delaysMs?: readonly number[] } = {},
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = (retriesUsed: number) => {
    if (cancelled) return;
    void attemptOnce(fetchImpl).then((outcome) => {
      if (cancelled) return;
      if (outcome.kind === "unreachable" && retriesUsed < delaysMs.length) {
        timer = setTimeout(() => run(retriesUsed + 1), delaysMs[retriesUsed]);
        return;
      }
      onDone(outcome);
    });
  };
  run(0);

  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
