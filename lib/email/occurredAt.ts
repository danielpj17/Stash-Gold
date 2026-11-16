/**
 * When did the purchase happen? Pure. (Plan §5.3.)
 *
 *   - The body gives an exact time → use it.
 *   - The body gives only a date, and it equals the email's LOCAL date in the
 *     scope's timezone → use the email's exact timestamp (alerts are sent
 *     within minutes, and the real time keeps ordering and month right).
 *   - The body gives a different date → anchor it at 12:00 UTC, the repo
 *     convention from resolveOccurredAt in lib/transactions.ts. Midnight UTC
 *     would land on the previous day everywhere west of UTC and could push a
 *     purchase into the wrong month.
 *   - No date at all → the email's timestamp.
 */

/** YYYY-MM-DD for an instant, in an IANA timezone. */
export function localDate(instantIso: string, timeZone: string): string {
  const d = new Date(instantIso);
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function resolveAlertOccurredAt(input: {
  occurredAt: string | null;
  occurredDate: string | null;
  emailReceivedAt: string;
  timeZone: string;
}): string {
  if (input.occurredAt) {
    const exact = new Date(input.occurredAt);
    if (!Number.isNaN(exact.getTime())) return exact.toISOString();
  }
  const received = new Date(input.emailReceivedAt).toISOString();
  if (!input.occurredDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.occurredDate)) return received;
  if (input.occurredDate === localDate(received, input.timeZone)) return received;
  return new Date(`${input.occurredDate}T12:00:00Z`).toISOString();
}
