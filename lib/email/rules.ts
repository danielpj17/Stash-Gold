import { EXPENSE_CATEGORIES } from "@/lib/constants";
import { STARTER_GUESSES } from "@/lib/email/config";

/**
 * Filing rules for a NEW email purchase (plan §5.5). Pure.
 *
 *   auto           confirmed, category = rule, categorized_by 'rule', no push
 *   ask_shortlist  needs_review, category = default (provisional, 'guess'),
 *                  choices = shortlist + Other
 *   ask_all        needs_review, category = default ?? starter guess ?? NULL
 *   skip           nothing is recorded (`ignored`, logged_by_hand): "Don't
 *                  record — I log these myself", e.g. a donation split across
 *                  several hand entries that no single row would match.
 *                  decide() stops before it ever reaches decideCategory.
 *
 * D2: a provisional guess COUNTS in its category's bar, drawn as an
 * "unconfirmed" share, until a person answers. A guess never creates a rule —
 * only an explicit "Always file it this way" does.
 *
 * PEOPLE (Venmo counterparties, `{ person: true }`) are never guessed: paying
 * the same friend is a different thing every time. No default, no starter
 * guess, and an answer is not remembered as one. Only the explicit choices
 * apply — "Always file <name> this way" (auto) and a shortlist. (Daniel,
 * 2026-11-16.)
 */

export type MerchantMode = "auto" | "ask_shortlist" | "ask_all" | "skip";

export type MerchantRule = {
  id: string;
  displayName: string;
  mode: MerchantMode;
  category: string | null;
  shortlist: string[];
  defaultCategory: string | null;
};

export type CategoryDecision = {
  reviewStatus: "needs_review" | "confirmed";
  category: string | null;
  categorizedBy: "rule" | "guess" | null;
  /** What the categorize screen offers first. 'all' = the full grid. */
  choices: string[] | "all";
};

export function isExpenseCategory(value: unknown): value is string {
  return typeof value === "string" && (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

/** Starter guess for a merchant key, matched on the whole key or a word prefix. */
export function starterGuess(key: string): string | null {
  for (const [prefix, category] of Object.entries(STARTER_GUESSES)) {
    if ((key === prefix || key.startsWith(`${prefix} `)) && isExpenseCategory(category)) return category;
  }
  return null;
}

export function decideCategory(
  merchant: MerchantRule | null,
  key: string,
  opts: { person?: boolean } = {},
): CategoryDecision {
  if (merchant?.mode === "auto" && isExpenseCategory(merchant.category)) {
    return { reviewStatus: "confirmed", category: merchant.category, categorizedBy: "rule", choices: "all" };
  }

  if (merchant?.mode === "ask_shortlist" && merchant.shortlist.length > 0) {
    const guess = !opts.person && isExpenseCategory(merchant.defaultCategory) ? merchant.defaultCategory : null;
    return {
      reviewStatus: "needs_review",
      category: guess,
      categorizedBy: guess ? "guess" : null,
      choices: merchant.shortlist.filter(isExpenseCategory),
    };
  }

  const guess = opts.person
    ? null
    : ((merchant && isExpenseCategory(merchant.defaultCategory) ? merchant.defaultCategory : null) ??
      starterGuess(key));
  return {
    reviewStatus: "needs_review",
    category: guess,
    categorizedBy: guess ? "guess" : null,
    choices: "all",
  };
}

/**
 * Apply an answer to a merchant rule (plan §5.5, "Answering"). Returns the new
 * rule fields, or null when the rule doesn't change.
 */
export function ruleAfterAnswer(
  merchant: MerchantRule,
  answer: { category: string; always?: boolean; addToShortlist?: boolean },
  opts: { person?: boolean } = {},
): Pick<MerchantRule, "mode" | "category" | "shortlist" | "defaultCategory"> | null {
  if (!isExpenseCategory(answer.category)) return null;
  // A person's answer is never remembered as their default (see top of file).
  const defaultCategory = opts.person ? merchant.defaultCategory : merchant.defaultCategory ?? answer.category;
  if (answer.always) {
    return { mode: "auto", category: answer.category, shortlist: merchant.shortlist, defaultCategory };
  }
  if (answer.addToShortlist) {
    const shortlist = merchant.shortlist.includes(answer.category)
      ? merchant.shortlist
      : [...merchant.shortlist, answer.category];
    return { mode: "ask_shortlist", category: merchant.category, shortlist, defaultCategory };
  }
  if (merchant.defaultCategory === null && !opts.person) {
    return { mode: merchant.mode, category: merchant.category, shortlist: merchant.shortlist, defaultCategory };
  }
  return null;
}
