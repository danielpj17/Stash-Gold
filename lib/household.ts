import { createHash, randomBytes } from "crypto";
import type { Sql } from "@/lib/db";

/**
 * Household sharing — two people, one Stash.
 *
 * The model is deliberately minimal: there is no household table and no
 * household id. `users.data_owner_id` points a member at the person whose data
 * scope they share, and `requireUser()` resolves it into `ApiUser.userId`. Every
 * other query in the app is unchanged and unaware.
 *
 * Exactly one level deep. `acceptInvite` refuses to attach to a user who is
 * themselves a member, so nothing ever has to walk a chain and there is no
 * cycle to guard against at read time.
 */

/** How long an invite stays redeemable. Long enough to survive a spam folder. */
export const INVITE_TTL_DAYS = 7;

export type HouseholdRole = "solo" | "owner" | "member";

export type HouseholdMember = {
  id: string;
  name: string | null;
  email: string | null;
  /** True for the person whose scope this is. */
  isOwner: boolean;
  /** True for the user making the request. */
  isYou: boolean;
};

export type PendingInvite = {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
};

/**
 * Invite tokens are 256 bits of CSPRNG output, so there is nothing to
 * brute-force and a plain SHA-256 is the right hash — identical reasoning to
 * `hashIngestToken` in lib/apiAuth.ts.
 */
export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw.trim()).digest("hex");
}

export function generateInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashInviteToken(raw) };
}

/** Addresses are compared case-folded everywhere; store them that way too. */
export function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Roughly RFC-shaped. The real validation is that a sign-in email must arrive. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

type UserRow = {
  id: string;
  name: string | null;
  email: string | null;
  data_owner_id: string | null;
};

/**
 * Everyone in `actorId`'s household, plus their role in it.
 *
 * Returns `solo` when nobody else is involved — the UI uses that to stay
 * completely invisible, including suppressing the name on reconcile rows.
 */
export async function loadHousehold(
  sql: Sql,
  actorId: string,
): Promise<{ role: HouseholdRole; ownerId: string; members: HouseholdMember[] }> {
  const rows = (await sql`
    WITH me AS (
      SELECT COALESCE(data_owner_id, id) AS owner_id FROM users WHERE id = ${actorId}
    )
    SELECT u.id, u.name, u.email, u.data_owner_id
    FROM users u, me
    WHERE u.id = me.owner_id OR u.data_owner_id = me.owner_id
    ORDER BY (u.data_owner_id IS NOT NULL), u.created_at
  `) as UserRow[];

  const ownerRow = rows.find((r) => r.data_owner_id === null);
  const ownerId = ownerRow?.id ?? actorId;

  const members: HouseholdMember[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    isOwner: r.id === ownerId,
    isYou: r.id === actorId,
  }));

  const role: HouseholdRole =
    members.length < 2 ? "solo" : ownerId === actorId ? "owner" : "member";

  return { role, ownerId, members };
}

/** The live invite for an owner, if any. Only owners ever have one. */
export async function loadPendingInvite(
  sql: Sql,
  ownerId: string,
): Promise<PendingInvite | null> {
  const rows = (await sql`
    SELECT id, email, created_at, expires_at
    FROM household_invites
    WHERE owner_user_id = ${ownerId}
      AND accepted_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<{ id: string; email: string; created_at: string; expires_at: string }>;

  const row = rows[0];
  return row
    ? { id: row.id, email: row.email, createdAt: row.created_at, expiresAt: row.expires_at }
    : null;
}

/**
 * Does this user already have data of their own?
 *
 * Joining a household repoints every read at the owner's scope, so a user with
 * existing data would keep it in the database but lose sight of it entirely.
 * v1 refuses rather than orphaning it — merging two datasets is a separate
 * problem, and a clear error beats silent disappearance.
 */
export async function hasOwnData(sql: Sql, userId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (SELECT 1 FROM transactions        WHERE user_id = ${userId})
        OR EXISTS (SELECT 1 FROM financial_accounts  WHERE user_id = ${userId})
        OR EXISTS (SELECT 1 FROM budget_store        WHERE user_id = ${userId}
                     AND data <> '{}'::jsonb)
        AS has_data
  `) as Array<{ has_data: boolean }>;
  return Boolean(rows[0]?.has_data);
}
