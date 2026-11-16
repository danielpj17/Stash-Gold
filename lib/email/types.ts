/**
 * Shared types for email transaction sync. See docs/email-sync-plan.md.
 *
 * Everything in lib/email/ except `pipeline.ts`, `context.ts`, `apply.ts`,
 * `unattended.ts` and `settings.ts` is PURE: no database, no network, no
 * `node:crypto`. That split is what makes shadow mode ("run decide, skip
 * apply"), the unit tests and the re-parse dry run possible.
 */

/** What the Apps Script poller sends for one Gmail message (validated). */
export type EmailPayload = {
  gmailMessageId: string;
  rfc822MessageId: string | null;
  from: string;
  to: string | null;
  subject: string;
  /** ISO instant the message was received. */
  date: string;
  plainBody: string;
  htmlBody: string;
  /** The script caps htmlBody at 1 MB and sets this when it had to. */
  truncated: boolean;
  headers: {
    deliveredTo: string | null;
    xForwardedFor: string | null;
    xForwardedTo: string | null;
    authenticationResults: string | null;
    arcAuthenticationResults: string | null;
  };
  pollerVersion: string | null;
};

/** The email as parsers see it. Built by `normalize.ts`. */
export type NormalizedEmail = {
  /** Lowercased bare address of the effective sender (forward-unwrapped). */
  from: string;
  fromDomain: string;
  /** True when `from` was recovered from a "Forwarded message" block. */
  unwrappedForward: boolean;
  to: string | null;
  /** Whose personal inbox forwarded it, lowercased (X-Forwarded-For). */
  forwardedFor: string | null;
  subject: string;
  /** ISO instant. */
  receivedAt: string;
  /** Plain text: the plain body, or the HTML body flattened to text. */
  text: string;
  html: string;
  authResults: string;
  arcAuthResults: string;
};

export type ParsedAlertKind =
  | "purchase"
  | "refund"
  | "declined"
  | "posted"
  | "amount_changed"
  | "payment_received"
  | "payment_sent"
  | "transfer";

export type AccountHint = { last4?: string; name?: string };

export type ParsedAlert = {
  kind: ParsedAlertKind;
  /** Positive integer cents. Never a float. */
  amountCents: number;
  /** Exactly as written in the email (Venmo: the counterparty). */
  merchantRaw: string;
  accountHint: AccountHint;
  /** ISO when the body gives a time. */
  occurredAt: string | null;
  /** YYYY-MM-DD when it gives only a date. */
  occurredDate: string | null;
  /** True for authorization alerts that a "posted" alert may later update. */
  isPending: boolean;
  /** Venmo. */
  counterparty?: string;
  /** Venmo. */
  memo?: string;
  /**
   * Venmo, if the receipt says what paid for it (D4). For a `transfer`, the
   * external side — the bank the money went to or came from.
   */
  fundingSource?: AccountHint | "balance";
  /** `transfer` only: which way money moved relative to the alert's account. */
  transferDirection?: "out" | "in";
  /** Amount-changed alerts that state the old amount. */
  previousAmountCents?: number;
};

export type ParseResult = ParsedAlert | { unparsed: string } | { ignore: string; kind?: ParsedAlertKind };

export type Parser = {
  /** Stored in financial_accounts.alert_source and email_events.parser_id. */
  id: string;
  /** Human name for Settings ("Venmo"). */
  label: string;
  /** Bump on ANY behaviour change; stored per event so re-reads are traceable. */
  version: number;
  /** Matched against the (unwrapped) From address. */
  senders: RegExp[];
  /** DKIM must pass for one of these (or a subdomain). */
  dkimDomains: string[];
  /** Default true. `false` needs a comment in the parser saying why. */
  requireDkim?: boolean;
  /**
   * How an account is identified for this source: by the card's last four, or
   * (Venmo) by whose inbox forwarded the alert.
   */
  accountKey: "last4" | "forwarded_from";
  parse(email: NormalizedEmail): ParseResult;
};

export function isParsedAlert(result: ParseResult): result is ParsedAlert {
  return typeof (result as ParsedAlert).kind === "string" && "amountCents" in result;
}

/** Terminal event statuses. `received` is the only non-terminal one (C14). */
export const EVENT_STATUSES = [
  "received",
  "created",
  "linked",
  "followup",
  "duplicate",
  "ignored",
  "unparsed",
  "unknown_account",
  "unauthenticated",
  "followup_ignored_reconciled",
  "ambiguous",
  "shadow",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
