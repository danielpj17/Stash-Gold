/** Human labels for email-sync statuses and reasons. Pure; safe in the browser. */

export const STATUS_LABELS: Record<string, string> = {
  received: "Processing",
  created: "Added",
  linked: "Matched an entry",
  followup: "Updated a purchase",
  duplicate: "Duplicate",
  ignored: "Ignored",
  unparsed: "Couldn't read",
  unknown_account: "Unknown account",
  unauthenticated: "Failed sender check",
  followup_ignored_reconciled: "Update skipped (reconciled)",
  ambiguous: "Which purchase?",
  shadow: "Shadow",
};

export const REASON_LABELS: Record<string, string> = {
  no_parser: "no reader for this sender yet",
  parser_threw: "reader error",
  invalid_parse: "reader returned bad data",
  no_last4: "no card number in the alert",
  no_forwarder: "can't tell whose inbox it came from",
  no_matching_account: "no account set up for it",
  no_authentication_results: "no sender verification",
  untrusted_authserv: "unverifiable sender",
  no_dkim_pass_for_sender: "didn't come from the bank",
  declined: "declined",
  venmo_request: "a request, not a payment",
  venmo_notice: "account notice",
  venmo_marketing: "newsletter",
  internal_counterparty: "between the two of you",
  transfer_not_tracked: "card payment or transfer",
  venmo_leg_pending_phase4: "Venmo transfer (not tracked yet)",
  gmail_forwarding_confirmation: "Gmail forwarding confirmation",
  apps_script_failure: "Apps Script failure notice",
  google_account_notice: "Google account notice",
  mail_delivery_failure: "bounce",
  same_alert: "same alert twice",
  authorization_after_posted: "arrived after its posted alert",
  venmo_transfer_already_recorded: "transfer already recorded",
  matched_manual_entry: "matched your entry",
  matched_manual_transfer: "matched your transfer",
  completed_venmo_side: "filled in the Venmo account",
  posted_same_amount: "posted, same amount",
  posted_new_amount: "posted, new amount",
  gas_hold_final: "gas hold → final",
  tip_added: "tip added",
  which_purchase_did_this_update: "matched several purchases",
  row_already_reconciled: "already reconciled",
  auto_rule: "filed by rule",
  ask_with_guess: "asked (with a guess)",
  ask: "asked",
  refund_as_income: "refund → Income",
  money_in_as_income: "money in → Income",
  venmo_transfer: "Venmo transfer",
  venmo_transfer_side_unknown: "Venmo transfer (which account?)",
  ambiguous_dismissed: "dismissed",
  dismissed_by_person: "dismissed",
  logged_by_hand: "you log these yourself",
  already_recorded: "already recorded",
  completed_transfer_side: "filled in the paying account",
  transfer_already_recorded: "transfer already recorded",
  account_transfer: "transfer between your accounts",
  transfer_side_unknown: "transfer (which account?)",
  split_into_parts: "one email per line",
  invalid_split: "reader returned bad data",
  wellsfargo_update_empty: "no activity listed",
  resolved_by_person: "you picked the purchase",
  split_back: "split back into two",
};

export function statusLabel(status: string | null | undefined): string {
  return (status && STATUS_LABELS[status]) || status || "";
}

export function reasonLabel(reason: string | null | undefined): string {
  return (reason && REASON_LABELS[reason]) || (reason ?? "").replace(/_/g, " ");
}

export function fmtCents(cents: number | null | undefined): string {
  if (typeof cents !== "number") return "";
  return `$${(cents / 100).toFixed(2)}`;
}

export function fmtDollars(amount: number | null | undefined): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "";
  return `$${amount.toFixed(2)}`;
}

export function fmtWhen(value: string | null | undefined): string {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "unknown";
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
