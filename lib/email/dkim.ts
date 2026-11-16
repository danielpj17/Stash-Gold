/**
 * The DKIM gate (plan §5.3). Pure.
 *
 * Anyone who learns the Stash inbox's address can send it a bank-looking
 * email. Requiring `dkim=pass` for the parser's own domain is what stops that
 * from creating transactions or triggering pushes.
 *
 * Only a verdict stamped by Google's own receiving server counts: the header
 * must start with the `mx.google.com` authserv-id. A sender can put any
 * Authentication-Results header they like into a message, but Gmail removes
 * forged ones bearing its own id, so a header claiming mx.google.com is one
 * Gmail wrote.
 *
 * Gmail filter forwarding usually keeps the bank's DKIM signature intact. When
 * a forward breaks it, Gmail's ARC verdict carries the original result: accept
 * an ARC-Authentication-Results dkim=pass only when Gmail's own top-level
 * header says `arc=pass` (i.e. Gmail validated the ARC chain).
 */

const TRUSTED_AUTHSERV = "mx.google.com";

/** Domains with a dkim=pass verdict in one Authentication-Results value. */
export function dkimPassDomains(header: string): string[] {
  const domains: string[] = [];
  // Each method result is separated by ';'. A dkim result looks like:
  //   dkim=pass header.i=@alerts.chase.com header.s=… header.b=…
  //   dkim=pass header.d=chase.com …
  for (const part of header.split(";")) {
    const m = /\bdkim\s*=\s*pass\b([^;]*)/i.exec(part);
    if (!m) continue;
    const props = m[1];
    const d = /header\.d\s*=\s*"?([A-Za-z0-9.-]+)/i.exec(props);
    const i = /header\.i\s*=\s*"?[^@\s;"]*@([A-Za-z0-9.-]+)/i.exec(props);
    const domain = (d?.[1] ?? i?.[1] ?? "").toLowerCase().replace(/\.$/, "");
    if (domain) domains.push(domain);
  }
  return domains;
}

function isTrustedHeader(header: string): boolean {
  // ARC-Authentication-Results starts with "i=1; mx.google.com; …".
  const withoutInstance = header.replace(/^\s*i\s*=\s*\d+\s*;\s*/i, "");
  return withoutInstance.trim().toLowerCase().startsWith(TRUSTED_AUTHSERV);
}

function domainMatches(candidate: string, allowed: string): boolean {
  const a = allowed.toLowerCase();
  return candidate === a || candidate.endsWith(`.${a}`);
}

export type DkimVerdict = { pass: true; domain: string; via: "dkim" | "arc" } | { pass: false; reason: string };

export function checkDkim(
  authResults: string,
  arcAuthResults: string,
  allowedDomains: string[],
): DkimVerdict {
  if (!authResults.trim()) return { pass: false, reason: "no_authentication_results" };
  if (!isTrustedHeader(authResults)) return { pass: false, reason: "untrusted_authserv" };

  for (const domain of dkimPassDomains(authResults)) {
    if (allowedDomains.some((allowed) => domainMatches(domain, allowed))) {
      return { pass: true, domain, via: "dkim" };
    }
  }

  const arcPassed = /\barc\s*=\s*pass\b/i.test(authResults);
  if (arcPassed && arcAuthResults.trim() && isTrustedHeader(arcAuthResults)) {
    for (const domain of dkimPassDomains(arcAuthResults)) {
      if (allowedDomains.some((allowed) => domainMatches(domain, allowed))) {
        return { pass: true, domain, via: "arc" };
      }
    }
  }
  return { pass: false, reason: "no_dkim_pass_for_sender" };
}
