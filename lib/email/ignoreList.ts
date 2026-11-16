import type { NormalizedEmail } from "@/lib/email/types";

/**
 * Mail that is expected in the Stash inbox but is not a transaction. These
 * become `ignored`, never `unparsed`, so the "Couldn't read" list stays a list
 * of things a person should look at. Pure.
 */
export type IgnoreMatch = {
  reason:
    | "gmail_forwarding_confirmation"
    | "apps_script_failure"
    | "google_account_notice"
    | "mail_delivery_failure";
  /** Raises the email-sync warning in Settings. */
  raisesWarning: boolean;
};

export function matchIgnoreList(email: NormalizedEmail): IgnoreMatch | null {
  const from = email.from;
  const subject = email.subject.toLowerCase();

  if (from === "forwarding-noreply@google.com" || /forwarding confirmation/.test(subject)) {
    return { reason: "gmail_forwarding_confirmation", raisesWarning: false };
  }
  // "Summary of failures for Google Apps Script: Stash poller"
  if (
    from === "apps-scripts-notifications@google.com" ||
    (/@google\.com$/.test(from) && /apps script/.test(subject))
  ) {
    return { reason: "apps_script_failure", raisesWarning: true };
  }
  if (
    from === "no-reply@accounts.google.com" ||
    from === "googleaccount-noreply@google.com" ||
    from === "google-noreply@google.com" ||
    (/@(accounts\.)?google\.com$/.test(from) && /security alert|sign-in|recovery|2-step/.test(subject))
  ) {
    return { reason: "google_account_notice", raisesWarning: false };
  }
  if (/^(mailer-daemon|postmaster)@/.test(from)) {
    return { reason: "mail_delivery_failure", raisesWarning: false };
  }
  return null;
}
