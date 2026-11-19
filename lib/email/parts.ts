/**
 * Parts of one email. A posted-activity summary lists several separate
 * transactions, but everything downstream — dedupe, follow-ups, the
 * one-row-per-event index on transactions, a status per event — is built for
 * one transaction per email. So the pipeline splits such an email into child
 * events, `<parent gmail id>#1` … `#n`: each is a full copy of the parent
 * (same body, same sender verification) that the parser reads only its part
 * of. Pure; safe in the browser.
 *
 * `#` never appears in a Gmail message id (they are hex), so a part id can't
 * collide with a real email.
 */

export const MAX_PARTS = 50;

/** 1-based part number, or null for a whole email. */
export function partOf(gmailMessageId: string): number | null {
  const m = /#(\d{1,3})$/.exec(gmailMessageId);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= MAX_PARTS ? n : null;
}

export function partId(parentGmailMessageId: string, part: number): string {
  return `${parentGmailMessageId}#${part}`;
}

/** The whole email a part came from (itself, for a whole email). */
export function wholeEmailId(gmailMessageId: string): string {
  return partOf(gmailMessageId) === null ? gmailMessageId : gmailMessageId.replace(/#\d{1,3}$/, "");
}
