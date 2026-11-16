import type { Sql } from "@/lib/db";

/**
 * Email sync settings for a data SCOPE (the household owner's id). A missing
 * row means every default — notably `shadow` mode, so nothing is ever written
 * from email until a person switches it on.
 */
export type EmailSyncSettings = {
  mode: "shadow" | "live";
  answerTimeoutHours: number;
  internalCounterparties: string[];
  lastHeartbeatAt: string | null;
  lastHeartbeatError: string | null;
  lastPollAt: string | null;
  lastIngestAt: string | null;
  pollerVersion: string | null;
  lastPollerFailureAt: string | null;
};

export const DEFAULT_EMAIL_SYNC_SETTINGS: EmailSyncSettings = {
  mode: "shadow",
  answerTimeoutHours: 24,
  internalCounterparties: [],
  lastHeartbeatAt: null,
  lastHeartbeatError: null,
  lastPollAt: null,
  lastIngestAt: null,
  pollerVersion: null,
  lastPollerFailureAt: null,
};

type Row = {
  mode: string;
  answer_timeout_hours: number;
  internal_counterparties: string[] | null;
  last_heartbeat_at: string | null;
  last_heartbeat_error: string | null;
  last_poll_at: string | null;
  last_ingest_at: string | null;
  poller_version: string | null;
  last_poller_failure_at: string | null;
};

function iso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function getEmailSyncSettings(sql: Sql, userId: string): Promise<EmailSyncSettings> {
  const rows = (await sql`
    SELECT mode, answer_timeout_hours, internal_counterparties, last_heartbeat_at,
           last_heartbeat_error, last_poll_at, last_ingest_at, poller_version,
           last_poller_failure_at
      FROM email_sync_settings
     WHERE user_id = ${userId}
  `) as Row[];
  const row = rows[0];
  if (!row) return { ...DEFAULT_EMAIL_SYNC_SETTINGS };
  return {
    mode: row.mode === "live" ? "live" : "shadow",
    answerTimeoutHours: Number(row.answer_timeout_hours ?? 24),
    internalCounterparties: Array.isArray(row.internal_counterparties) ? row.internal_counterparties : [],
    lastHeartbeatAt: iso(row.last_heartbeat_at),
    lastHeartbeatError: row.last_heartbeat_error,
    lastPollAt: iso(row.last_poll_at),
    lastIngestAt: iso(row.last_ingest_at),
    pollerVersion: row.poller_version,
    lastPollerFailureAt: iso(row.last_poller_failure_at),
  };
}

/**
 * Is email sync writing real rows for this scope? The manual-entry dedupe in
 * `insertOrLinkTransaction` only runs when it is.
 */
export async function isEmailSyncLive(sql: Sql, userId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM email_sync_settings WHERE user_id = ${userId} AND mode = 'live'
  `) as unknown[];
  return rows.length > 0;
}

export function normalizeCounterparty(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
