import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import {
  INVITE_TTL_DAYS,
  generateInviteToken,
  loadHousehold,
  loadPendingInvite,
  looksLikeEmail,
  normalizeEmail,
} from "@/lib/household";
import { renderInviteEmail } from "@/lib/inviteEmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Household membership: who shares this Stash, and the invitation that gets
 * them here.
 *
 * Every handler authorizes on `actorId` (the signed-in person), not `userId`
 * (the shared data scope) — this route is *about* the relationship between
 * users rather than data inside one scope, so it is the one place where "which
 * human is this" is the question being asked.
 *
 * Session-only. An ingest token identifies a person well enough to log a
 * transaction, but it must never be able to hand out access to the household.
 */

const SMTP_PORT = Number(process.env.EMAIL_SERVER_PORT ?? 465);

async function loadState(
  sql: Parameters<typeof loadHousehold>[0],
  actorId: string,
) {
  const { role, ownerId, members } = await loadHousehold(sql, actorId);
  // Only an owner can have a pending invite, and only they should see it.
  const pendingInvite = role === "member" ? null : await loadPendingInvite(sql, ownerId);
  return { role, members, pendingInvite };
}

export async function GET() {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, actorId } = ctx;

  try {
    return NextResponse.json(await loadState(sql, actorId));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load household" },
      { status: 502 },
    );
  }
}

/** Set your OWN display name. Never another member's — see the actorId note. */
export async function PATCH(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, actorId } = ctx;

  let body: { name?: unknown };
  try {
    body = (await request.json()) as { name?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = typeof body.name === "string" ? body.name.trim() : "";
  if (raw.length > 60) {
    return NextResponse.json({ error: "Name must be 60 characters or fewer" }, { status: 400 });
  }
  // Empty clears it, which puts the row back to showing no name at all rather
  // than an empty separator on the reconcile page.
  const name = raw || null;

  try {
    await sql`UPDATE users SET name = ${name} WHERE id = ${actorId}`;
    return NextResponse.json(await loadState(sql, actorId));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save name" },
      { status: 502 },
    );
  }
}

/** Invite someone to share this Stash. Owner-only. */
export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, actorId } = ctx;

  let body: { email?: unknown };
  try {
    body = (await request.json()) as { email?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  if (!looksLikeEmail(email)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  try {
    const { role, ownerId, members } = await loadHousehold(sql, actorId);

    // A member can't invite a third person, and can't invite at all: sharing is
    // one owner plus one guest, and only the owner decides who that is.
    if (role === "member") {
      return NextResponse.json(
        { error: "Only the person who owns this Stash can invite someone" },
        { status: 403 },
      );
    }
    if (members.length >= 2) {
      return NextResponse.json(
        { error: "This Stash is already shared. Remove the current person first." },
        { status: 409 },
      );
    }
    if (members.some((m) => normalizeEmail(m.email) === email)) {
      return NextResponse.json({ error: "That's your own address" }, { status: 400 });
    }

    // If the address already belongs to a Stash user, refuse early rather than
    // at acceptance — a rejection after they click through is a worse
    // experience, and the owner is the one who can fix it.
    const existing = (await sql`
      SELECT id, data_owner_id FROM users WHERE lower(email) = ${email}
    `) as Array<{ id: string; data_owner_id: string | null }>;
    if (existing[0]?.data_owner_id) {
      return NextResponse.json(
        { error: "That person already shares someone else's Stash" },
        { status: 409 },
      );
    }

    const { raw, hash } = generateInviteToken();

    // Supersede any earlier live invite so the partial unique index holds and
    // an old link stops working the moment a new one is sent.
    await sql`
      UPDATE household_invites
         SET revoked_at = now()
       WHERE owner_user_id = ${ownerId} AND accepted_at IS NULL AND revoked_at IS NULL
    `;
    await sql`
      INSERT INTO household_invites (owner_user_id, email, token_hash, expires_at)
      VALUES (${ownerId}, ${email}, ${hash},
              now() + ${`${INVITE_TTL_DAYS} days`}::interval)
    `;

    const me = members.find((m) => m.isYou);
    const base = (process.env.AUTH_URL ?? "").replace(/\/+$/, "");
    const { subject, text, html } = renderInviteEmail({
      inviterLabel: me?.name?.trim() || me?.email || "Someone",
      url: `${base}/invite/${raw}`,
      days: INVITE_TTL_DAYS,
    });

    await nodemailer
      .createTransport({
        host: process.env.EMAIL_SERVER_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,
        auth: {
          user: process.env.EMAIL_SERVER_USER,
          pass: process.env.EMAIL_SERVER_PASSWORD,
        },
      })
      .sendMail({ to: email, from: process.env.EMAIL_FROM, subject, text, html });

    return NextResponse.json(await loadState(sql, actorId), { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to send the invitation" },
      { status: 502 },
    );
  }
}

/**
 * Revoke a pending invite, or remove the other person.
 *
 * Removing does not touch a single transaction: the data belongs to the scope,
 * not to whoever typed it, and `entered_by` keeps resolving because the user
 * row survives. They simply stop being able to reach it.
 */
export async function DELETE(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, actorId } = ctx;

  let body: { memberId?: unknown; inviteId?: unknown };
  try {
    body = (await request.json()) as { memberId?: unknown; inviteId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
  const inviteId = typeof body.inviteId === "string" ? body.inviteId.trim() : "";
  if (!memberId && !inviteId) {
    return NextResponse.json({ error: "memberId or inviteId is required" }, { status: 400 });
  }

  try {
    const { role, ownerId } = await loadHousehold(sql, actorId);
    if (role === "member") {
      return NextResponse.json(
        { error: "Only the person who owns this Stash can do that" },
        { status: 403 },
      );
    }

    if (inviteId) {
      await sql`
        UPDATE household_invites
           SET revoked_at = now()
         WHERE id = ${inviteId}::uuid
           AND owner_user_id = ${ownerId}
           AND accepted_at IS NULL
           AND revoked_at IS NULL
      `;
    }

    if (memberId) {
      if (memberId === ownerId) {
        return NextResponse.json({ error: "You can't remove yourself" }, { status: 400 });
      }
      // Scoped by data_owner_id as well as id, so this can only ever detach
      // someone from THIS household.
      await sql`
        UPDATE users SET data_owner_id = NULL
         WHERE id = ${memberId}::uuid AND data_owner_id = ${ownerId}
      `;
    }

    return NextResponse.json(await loadState(sql, actorId));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update household" },
      { status: 502 },
    );
  }
}
