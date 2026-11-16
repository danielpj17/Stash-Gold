import type { EmailPayload, NormalizedEmail } from "@/lib/email/types";

/**
 * Turn the poller's payload into what parsers read. Pure and browser-safe.
 */

/** "Chase <no.reply@chase.com>" → "no.reply@chase.com" (lowercased). */
export function extractAddress(header: string | null | undefined): string {
  const value = String(header ?? "").trim();
  if (!value) return "";
  const angle = /<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(value);
  if (angle) return angle[1].toLowerCase();
  const bare = /([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(value);
  return bare ? bare[1].toLowerCase() : value.toLowerCase();
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  bull: "•",
  middot: "·",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  zwnj: "",
  zwj: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return match;
      try {
        return String.fromCodePoint(n);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Flatten an HTML alert into lines of text. Alerts are table soup; block-level
 * tags become line breaks so "Amount" and "$14.82" in adjacent cells stay on
 * separate, predictable lines rather than running together.
 */
export function htmlToText(html: string): string {
  if (!html) return "";
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|header|footer|blockquote)>/gi, "\n");
  s = s.replace(/<(td|th)\b[^>]*>/gi, " ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[​-‏﻿­]/g, "");
  s = s.replace(/ /g, " ");
  return s
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Plain-text normalisation: same line discipline as htmlToText. */
export function cleanPlainText(text: string): string {
  return decodeEntities(text)
    .replace(/[​-‏﻿­]/g, "")
    .replace(/ /g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Recover the original sender from a hand-forwarded email.
 *
 * Gmail FILTER forwarding keeps the bank as `From:`, so this is the fallback
 * for someone pressing Forward by hand. The DKIM gate still applies to the
 * real message, so a hand-forward from a personal address only ever gets
 * through for a parser that sets `requireDkim: false`.
 */
export function unwrapForwardedSender(text: string): string | null {
  const marker = /-{5,}\s*Forwarded message\s*-{5,}|Begin forwarded message:/i.exec(text);
  if (!marker) return null;
  const after = text.slice(marker.index + marker[0].length, marker.index + marker[0].length + 2000);
  const fromLine = /^\s*From:\s*(.+)$/im.exec(after);
  if (!fromLine) return null;
  const address = extractAddress(fromLine[1]);
  return address.includes("@") ? address : null;
}

export function normalizeEmail(payload: EmailPayload): NormalizedEmail {
  // Prefer the plain part when it has real content. Some senders' plain part
  // is only "View this email in your browser", so fall back to the HTML then.
  const plain = payload.plainBody ? cleanPlainText(payload.plainBody) : "";
  const text = plain.length >= 80 || !payload.htmlBody ? plain : htmlToText(payload.htmlBody);
  const headerFrom = extractAddress(payload.from);
  const unwrapped = unwrapForwardedSender(text);
  const from = unwrapped ?? headerFrom;
  const forwardedFor = payload.headers.xForwardedFor
    ? extractAddress(payload.headers.xForwardedFor) || null
    : null;
  return {
    from,
    fromDomain: domainOf(from),
    unwrappedForward: Boolean(unwrapped),
    to: payload.to ? extractAddress(payload.to) || null : null,
    forwardedFor,
    subject: decodeEntities(payload.subject ?? "").replace(/\s+/g, " ").trim(),
    receivedAt: payload.date,
    text,
    html: payload.htmlBody,
    authResults: payload.headers.authenticationResults ?? "",
    arcAuthResults: payload.headers.arcAuthenticationResults ?? "",
  };
}
