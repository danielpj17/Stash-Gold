/**
 * Every tunable threshold for email sync, in one place (plan §5.6).
 *
 * The heuristic switches are also the Phase 4 rollback: turning one off makes
 * that rule fall through to "a new, separate transaction", which is always
 * safe — at worst it leaves a pending row for the CSV pass to correct.
 */
export const EMAIL_SYNC_CONFIG = {
  /** How far back a follow-up alert may look for the purchase it updates. */
  followupWindowDays: 5,
  /** D3: a tip may raise the amount by up to this much… */
  tipMaxIncreasePct: 35,
  /** …and only when the new alert is at least this long after the first. */
  tipMinGapHours: 12,
  /** Pre-authorization amounts a pump places before the real fill-up. */
  gasHoldExactAmounts: [1.0],
  /** Round holds in this range (whole multiples of $25) also count. */
  gasHoldRoundRange: [50, 200] as [number, number],
  tipCategories: ["Eating Out", "Dates"],
  gasCategory: "Gas",
  /** Two copies of one alert (redelivery, both spouses forwarding). */
  duplicateAlertWindowMinutes: 15,
  /** A manual entry and an alert for the same purchase. */
  manualMatchWindowDays: 2,
  /** Reconcile's "Correct to $X & link" suggestion. */
  csvSuggestWindowDays: 3,
  csvSuggestMaxIncreasePct: 35,
  /** Pairing a bank/card VENMO line with the Venmo receipt (D4). */
  venmoCardMatchWindowDays: 1,
  /** Settings turns amber after this long with no heartbeat. */
  heartbeatStaleMinutes: 30,
  /** New Expense shows a banner after this long with no heartbeat. */
  heartbeatBannerHours: 6,
  /** Abuse guard on the ingest route, per scope. */
  maxEventsPerMinute: 120,
  /** Bodies larger than this are refused (the script caps at 1 MB). */
  maxBodyBytes: 2 * 1024 * 1024,

  // ---- Phase 4 switches (rollback = set to false) ------------------------
  enableGasHoldHeuristic: true as boolean,
  enableTipHeuristic: true as boolean,
  enableOutOfOrder: true as boolean,
  /** D4: create Venmo transfers. Off = record Venmo legs as ignored. */
  enableVenmoTransfers: true as boolean,
  /** Manual↔email matching tolerates tip / gas-hold amounts, not just equal. */
  enableToleranceLinking: true as boolean,
} as const;

/**
 * Starter category guesses for brand-new merchants, matched against the
 * merchantKey output (whole key, or key prefix followed by a space). A guess
 * counts provisionally — marked unconfirmed — until someone answers (D2), and
 * never creates a rule on its own. Edit freely; category names must be in
 * EXPENSE_CATEGORIES.
 */
export const STARTER_GUESSES: Record<string, string> = {
  MAVERIK: "Gas",
  CHEVRON: "Gas",
  SHELL: "Gas",
  HARMONS: "Groceries",
  MACEYS: "Groceries",
  SMITHS: "Groceries",
};
