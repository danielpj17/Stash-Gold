import type { AccountRef } from "@/lib/email/decide";
import type { NormalizedEmail, ParsedAlert, Parser } from "@/lib/email/types";

/**
 * Which account is this alert about? Pure. (Plan §5.4.)
 *
 *   1. last4 present → the live account with alert_source = parser AND
 *      alert_last4 = last4. A partial unique index guarantees at most one.
 *   2. no last4 (Venmo) → alert_source = parser AND alert_forwarded_from =
 *      lower(forwarded_for ?? to).
 *   3. otherwise → unknown_account.
 *
 * NEVER fall back to "the only account for this bank": a replacement card or
 * a brand-new card would silently post to the wrong account. Unknown accounts
 * are listed in Settings → Email sync, where assigning one re-processes them.
 */
export type AccountResolution =
  | { account: AccountRef; key: { last4?: string; forwardedFrom?: string } }
  | { account: null; reason: "no_last4" | "no_forwarder" | "no_matching_account"; key: { last4?: string; forwardedFrom?: string } };

export function forwardedFromKey(email: Pick<NormalizedEmail, "forwardedFor" | "to">): string | null {
  const value = (email.forwardedFor ?? email.to ?? "").trim().toLowerCase();
  return value || null;
}

export function resolveAccount(
  parser: Pick<Parser, "id" | "accountKey">,
  alert: ParsedAlert,
  email: Pick<NormalizedEmail, "forwardedFor" | "to">,
  accounts: AccountRef[],
): AccountResolution {
  if (parser.accountKey === "last4") {
    const last4 = alert.accountHint.last4;
    if (!last4) return { account: null, reason: "no_last4", key: {} };
    const hit = accounts.find((a) => a.alertSource === parser.id && a.alertLast4 === last4);
    return hit
      ? { account: hit, key: { last4 } }
      : { account: null, reason: "no_matching_account", key: { last4 } };
  }

  const forwardedFrom = forwardedFromKey(email);
  if (!forwardedFrom) return { account: null, reason: "no_forwarder", key: {} };
  const hit = accounts.find(
    (a) => a.alertSource === parser.id && (a.alertForwardedFrom ?? "").toLowerCase() === forwardedFrom,
  );
  return hit
    ? { account: hit, key: { forwardedFrom } }
    : { account: null, reason: "no_matching_account", key: { forwardedFrom } };
}
