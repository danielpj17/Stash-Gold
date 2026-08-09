/**
 * The household invitation email.
 *
 * Light-first for the same reason as lib/signInEmail.ts, not as a style choice:
 * Gmail's dark mode force-inverts emails that don't declare color-scheme
 * support, and its inversion is tuned for light designs — a dark-built email
 * comes out as a washed-out light one. Ship light, declare color-scheme so
 * clients that honour it get the real dark palette, and let Gmail invert the
 * light version competently.
 *
 * Deliberately vague about what is being shared. The recipient's inbox is not
 * necessarily private, and "Dan invited you to share a budget" leaks less than
 * naming balances or accounts.
 */
export function renderInviteEmail(params: {
  /** The owner's name if they set one, otherwise their email address. */
  inviterLabel: string;
  /** Absolute URL to /invite/<token>. */
  url: string;
  days: number;
}): { subject: string; text: string; html: string } {
  const { inviterLabel, url, days } = params;

  return {
    subject: `${inviterLabel} invited you to share their Stash`,

    text: [
      `${inviterLabel} invited you to share their budget on Stash.`,
      ``,
      `Accept the invitation:`,
      url,
      ``,
      `You'll sign in with this email address and see the same budget,`,
      `accounts and transactions they do. Anything you add is labelled with`,
      `your name.`,
      ``,
      `This invitation expires in ${days} days and only works for this email`,
      `address. If you weren't expecting it, you can ignore it.`,
    ].join("\n"),

    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .bg    { background:#141414 !important; }
    .card  { background:#252525 !important; border-color:#3a3a3a !important; }
    .head  { background:#303030 !important; border-color:#3a3a3a !important; }
    .title { color:#ffffff !important; }
    .body  { color:#d6dae0 !important; }
    .muted { color:#9aa2ab !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f2f3f5">
<div class="bg" style="background:#f2f3f5;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div class="card" style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:12px;overflow:hidden">
    <div class="head" style="padding:16px 24px;background:#f7f8f9;border-bottom:1px solid #e3e5e8">
      <h1 class="title" style="margin:0;color:#14181f;font-size:17px;font-weight:600">You&rsquo;ve been invited to Stash</h1>
    </div>
    <div style="padding:24px">
      <p class="body" style="margin:0 0 20px;color:#2c333c;font-size:15px;line-height:1.55">
        <strong>${escapeHtml(inviterLabel)}</strong> invited you to share their budget.
        You&rsquo;ll sign in with your own email and see the same budget, accounts
        and transactions &mdash; anything you add is labelled with your name.
      </p>
      <a href="${url}" style="display:inline-block;background:#1a8f4c;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:6px;font-size:14px">Accept invitation</a>
      <p class="muted" style="margin:22px 0 0;color:#6b7480;font-size:12px;line-height:1.5">
        Expires in ${days} days and only works for the address it was sent to.
        Weren&rsquo;t expecting this? Ignore this email &mdash; nothing is shared
        until you accept.
      </p>
    </div>
  </div>
</div>
</body>
</html>`.trim(),
  };
}

/** The inviter's label is user-supplied, and it lands inside markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
