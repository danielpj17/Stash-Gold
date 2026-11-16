import type { EmailPayload } from "@/lib/email/types";

/**
 * Validate the Apps Script poller's request body. Pure.
 *
 * The body carries NO identity — the bearer token resolves the scope — so
 * nothing here is trusted to say whose data this is. `to` and the forwarding
 * headers are used later only to pick an account INSIDE the resolved scope.
 */

const MAX_FIELD = 1_100_000; // the script caps htmlBody at 1 MB; leave headroom

function str(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function body(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) : value;
}

export function validateEmailPayload(raw: unknown): EmailPayload | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Body must be a JSON object" };
  }
  const b = raw as Record<string, unknown>;

  const gmailMessageId = str(b.gmailMessageId, 200);
  if (!gmailMessageId) return { error: "gmailMessageId is required" };
  if (!/^[A-Za-z0-9_-]+$/.test(gmailMessageId)) {
    return { error: "gmailMessageId has an unexpected format" };
  }

  const from = str(b.from, 500);
  if (!from) return { error: "from is required" };

  const dateRaw = str(b.date, 100);
  const date = dateRaw ? new Date(dateRaw) : null;
  if (!date || Number.isNaN(date.getTime())) return { error: "date must be an ISO timestamp" };

  const plainBody = body(b.plainBody);
  const htmlBody = body(b.htmlBody);
  if (!plainBody && !htmlBody) return { error: "plainBody or htmlBody is required" };

  const headers =
    b.headers && typeof b.headers === "object" && !Array.isArray(b.headers)
      ? (b.headers as Record<string, unknown>)
      : {};
  const header = (...keys: string[]) => {
    for (const key of keys) {
      const value = str(headers[key], 8000);
      if (value) return value;
    }
    return null;
  };

  return {
    gmailMessageId,
    rfc822MessageId: str(b.rfc822MessageId, 1000),
    from,
    to: str(b.to, 2000),
    subject: str(b.subject, 1000) ?? "",
    date: date.toISOString(),
    plainBody,
    htmlBody,
    truncated: b.truncated === true,
    headers: {
      deliveredTo: header("Delivered-To", "deliveredTo"),
      xForwardedFor: header("X-Forwarded-For", "xForwardedFor"),
      xForwardedTo: header("X-Forwarded-To", "xForwardedTo"),
      authenticationResults: header("Authentication-Results", "authenticationResults"),
      arcAuthenticationResults: header("ARC-Authentication-Results", "arcAuthenticationResults"),
    },
    pollerVersion: str(b.pollerVersion, 50),
  };
}

/** The heartbeat body. Everything optional; nothing in it is trusted for identity. */
export function validateHeartbeat(raw: unknown): {
  pollerVersion: string | null;
  lastPollAt: string | null;
  lastError: string | null;
} {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const at = str(b.lastPollAt, 100);
  const parsed = at ? new Date(at) : null;
  return {
    pollerVersion: str(b.pollerVersion, 50),
    lastPollAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    lastError: str(b.lastError, 1000),
  };
}
