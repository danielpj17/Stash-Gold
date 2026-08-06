/**
 * The magic-link / sign-in-code email.
 *
 * Light-first by design, not by preference. Gmail's dark mode force-inverts
 * emails that don't declare color-scheme support, and its inversion is tuned
 * for light designs — a dark-built email comes out as a washed-out light one.
 * So: ship light, declare color-scheme so clients that honour it (Apple Mail,
 * iOS Mail) get the real dark palette in the media query, and let Gmail's
 * inversion do a decent job on the light version.
 *
 * Contrast is kept high enough that it survives inversion either way: no
 * near-white text on near-white backgrounds, no near-black on near-black.
 *
 * Lives here rather than inline in auth.ts so it can be rendered and previewed
 * without going through a real sign-in.
 */
export function renderSignInEmail(params: {
  /** Display form, e.g. "NF4M-TX32". */
  code: string;
  url: string;
  minutes: number;
}): { subject: string; text: string; html: string } {
  const { code, url, minutes } = params;

  return {
    // Code in the subject so it's readable straight from the notification.
    subject: `Your Stash sign-in code: ${code}`,

    // "Your ... code is X" is the shape iOS recognises for AutoFill.
    text: [
      `Your Stash sign-in code is ${code}`,
      ``,
      `Enter it on the "Check your email" screen — this is the one that works`,
      `if you added Stash to your home screen.`,
      ``,
      `Or open this link in a browser:`,
      url,
      ``,
      `The code and link both expire in ${minutes} minutes and can be used once.`,
      `If you didn't request this, you can ignore it.`,
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
    .label { color:#b9bfc7 !important; }
    .muted { color:#9aa2ab !important; }
    .code  { color:#63d68c !important; background:#1b1b1b !important; border-color:#3a3a3a !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f2f3f5">
<div class="bg" style="background:#f2f3f5;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div class="card" style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:12px;overflow:hidden">
    <div class="head" style="padding:16px 24px;background:#f7f8f9;border-bottom:1px solid #e3e5e8">
      <h1 class="title" style="margin:0;color:#14181f;font-size:17px;font-weight:600">Sign in to Stash</h1>
    </div>
    <div style="padding:24px">
      <p class="label" style="margin:0 0 10px;color:#5b6470;font-size:13px">Your sign-in code</p>
      <div class="code" style="margin:0 0 10px;color:#127a41;background:#f2faf5;border:1px solid #d6ebdf;border-radius:8px;padding:14px 12px;text-align:center;font-size:30px;line-height:1.2;font-weight:700;letter-spacing:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;-webkit-user-select:all;user-select:all">${code}</div>
      <p class="muted" style="margin:0 0 22px;color:#6b7480;font-size:12px;line-height:1.5">
        Tap and hold the code to copy it, then type or paste it on the
        &ldquo;Check your email&rdquo; screen. Use the code if you added Stash to
        your home screen &mdash; a tapped link opens in Safari, which won&rsquo;t
        sign you in inside the app.
      </p>
      <p class="label" style="margin:0 0 10px;color:#5b6470;font-size:13px">Or, in a browser:</p>
      <a href="${url}" style="display:inline-block;background:#1a8f4c;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:6px;font-size:14px">Sign in</a>
      <p class="muted" style="margin:22px 0 0;color:#6b7480;font-size:12px;line-height:1.5">
        Expires in ${minutes} minutes and works once. Didn&rsquo;t request it? Ignore this email.
      </p>
    </div>
  </div>
</div>
</body>
</html>`.trim(),
  };
}
