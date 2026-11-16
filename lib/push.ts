import webpush from "web-push";
import type { Sql } from "@/lib/db";
import { getEmailSyncSettings } from "@/lib/email/settings";
import { settleUnattended } from "@/lib/email/unattended";

/**
 * Web push (plan §5.9).
 *
 * `push_subscriptions.user_id` and `notification_prefs.user_id` are the ACTOR
 * — a phone belongs to a person (the user_tokens precedent). The fan-out below
 * reaches the household through a `users` join, so someone who leaves the
 * household stops getting pushes with no other change.
 *
 * Payloads carry the merchant, the amount and the account NAME only — never a
 * card number.
 *
 * iOS revokes subscriptions that receive pushes without a visible
 * notification, so the service worker ALWAYS shows one (worker/index.ts).
 */

export type PushPayload = {
  title: string;
  body: string;
  /** Repeats with the same tag replace rather than stack. */
  tag: string;
  url: string;
};

type SubscriptionRow = {
  user_id: string;
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

let configured: boolean | null = null;

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}

export function pushConfigured(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!pub || !priv || !subject) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Send to one device. Prunes dead endpoints; never throws. */
async function sendOne(sql: Sql, sub: SubscriptionRow, payload: PushPayload): Promise<boolean> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 24, urgency: "normal" },
    );
    await sql`
      UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0
       WHERE user_id = ${sub.user_id} AND id = ${sub.id}::uuid
    `;
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      // The push service says this subscription is gone for good.
      await sql`DELETE FROM push_subscriptions WHERE user_id = ${sub.user_id} AND id = ${sub.id}::uuid`;
    } else {
      await sql`
        UPDATE push_subscriptions
           SET last_failure_at = now(), failure_count = failure_count + 1
         WHERE user_id = ${sub.user_id} AND id = ${sub.id}::uuid
      `;
    }
    return false;
  }
}

/**
 * Push "categorize this" to everyone in the household who opted in for this
 * account. With no recipients the item is due immediately and settles inline,
 * per the account's unattended setting.
 */
export async function notifyNeedsReview(
  sql: Sql,
  scopeUserId: string,
  info: {
    transactionId: string;
    accountId: string;
    accountName: string;
    merchantName: string;
    amountCents: number;
    choices: string[] | "all";
    /** The description the row was saved with (editable on the screen the tap opens). */
    description?: string | null;
  },
): Promise<{ sent: number }> {
  const settings = await getEmailSyncSettings(sql, scopeUserId);

  const recipients = pushConfigured()
    ? ((await sql`
        SELECT ps.user_id, ps.id, ps.endpoint, ps.p256dh, ps.auth
          FROM push_subscriptions ps
          JOIN users u ON u.id = ps.user_id
          JOIN notification_prefs np ON np.user_id = ps.user_id AND np.account_id = ${info.accountId}::uuid
         WHERE COALESCE(u.data_owner_id, u.id) = ${scopeUserId}::uuid AND np.enabled
      `) as SubscriptionRow[])
    : [];

  if (recipients.length === 0) {
    await sql`
      UPDATE transactions SET unattended_due_at = now()
       WHERE user_id = ${scopeUserId} AND id = ${info.transactionId} AND unattended_due_at IS NULL
    `;
    await settleUnattended(sql, scopeUserId);
    return { sent: 0 };
  }

  const question =
    Array.isArray(info.choices) && info.choices.length > 0 && info.choices.length <= 3
      ? `${info.choices.join(" or ")}?`
      : "Which category?";
  // Show the description that will be saved when it says more than the
  // merchant name (a Venmo note, "Refund · …"); it already names the merchant.
  const description = info.description?.trim() ?? "";
  const head =
    description && description !== info.merchantName
      ? `${fmtMoney(info.amountCents)} · ${info.accountName}\n${description.slice(0, 120)}`
      : `${fmtMoney(info.amountCents)} at ${info.merchantName} · ${info.accountName}`;
  const payload: PushPayload = {
    title: "Categorize a purchase",
    body: `${head}\n${question}`,
    tag: info.transactionId,
    url: `/categorize/${encodeURIComponent(info.transactionId)}`,
  };

  let sent = 0;
  for (const sub of recipients) {
    if (await sendOne(sql, sub, payload)) sent += 1;
  }

  await sql`
    UPDATE transactions
       SET notified_at = now(),
           unattended_due_at = now() + make_interval(hours => ${settings.answerTimeoutHours})
     WHERE user_id = ${scopeUserId} AND id = ${info.transactionId}
  `;
  return { sent };
}

/** "Send test notification" — only this person's own devices. */
export async function sendTestToActor(sql: Sql, actorId: string): Promise<{ sent: number; devices: number }> {
  if (!pushConfigured()) return { sent: 0, devices: 0 };
  const subs = (await sql`
    SELECT user_id, id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ${actorId}
  `) as SubscriptionRow[];
  let sent = 0;
  for (const sub of subs) {
    if (
      await sendOne(sql, sub, {
        title: "Stash",
        body: "Test notification — notifications are working.",
        tag: "stash-test",
        url: "/settings#notifications",
      })
    ) {
      sent += 1;
    }
  }
  return { sent, devices: subs.length };
}
