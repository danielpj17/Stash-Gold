import { randomInt } from "crypto";
import NextAuth from "next-auth";
import NeonAdapter from "@auth/neon-adapter";
import Nodemailer from "next-auth/providers/nodemailer";
import nodemailer from "nodemailer";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { formatSignInCode, generateSignInCode } from "@/lib/signInCode";

/**
 * The adapter only ever calls `pool.query(sql, params)` — never `connect()`,
 * never BEGIN — and registers no pool lifecycle listeners. That is exactly the
 * precondition for poolQueryViaFetch, so every auth query rides the same
 * low-latency HTTP path as the rest of the app: no WebSocket, no pool to manage
 * inside a serverless function.
 */
neonConfig.poolQueryViaFetch = true;

const NINETY_DAYS = 60 * 60 * 24 * 90;
const ONE_DAY = 60 * 60 * 24;
const SMTP_PORT = Number(process.env.EMAIL_SERVER_PORT ?? 465);

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  // Constructed per request, per the Auth.js Neon guide.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  return {
    adapter: NeonAdapter(pool),

    // Database sessions. maxAge 90d + updateAge 1d means the sessions row is
    // rolled forward at most once a day per user rather than on every request —
    // that matters on the Neon free tier.
    session: { strategy: "database", maxAge: NINETY_DAYS, updateAge: ONE_DAY },

    pages: {
      signIn: "/signin",
      verifyRequest: "/signin/check-email",
      error: "/signin",
    },

    providers: [
      Nodemailer({
        server: {
          host: process.env.EMAIL_SERVER_HOST, // smtp.gmail.com
          port: SMTP_PORT, // 465
          secure: SMTP_PORT === 465,
          auth: {
            user: process.env.EMAIL_SERVER_USER, // you@gmail.com
            pass: process.env.EMAIL_SERVER_PASSWORD, // 16-char Gmail App Password
          },
        },
        from: process.env.EMAIL_FROM, // "Stash <you@gmail.com>"
        maxAge: 15 * 60, // link and code validity

        // The verification token doubles as a human-typeable sign-in code.
        // Auth.js hashes it before storing and deletes it on use, so the code
        // inherits the link's single-use, time-limited handling exactly.
        generateVerificationToken: () => generateSignInCode(randomInt),

        // Custom email so it carries BOTH the link and the code. The link is
        // the fast path on desktop; the code is the only thing that works from
        // an installed iOS PWA, whose cookie jar Safari can't write into.
        async sendVerificationRequest({ identifier, url, provider, token, expires }) {
          const transport = nodemailer.createTransport(provider.server);
          const code = formatSignInCode(token);
          const minutes = Math.max(
            1,
            Math.round((new Date(expires).getTime() - Date.now()) / 60000),
          );

          await transport.sendMail({
            to: identifier,
            from: provider.from,
            subject: `Your Stash sign-in code: ${code}`,
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
            html: `
<div style="background:#1A1A1A;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#252525;border-radius:12px;overflow:hidden">
    <div style="padding:20px 24px;background:#353535">
      <h1 style="margin:0;color:#fff;font-size:17px">Sign in to Stash</h1>
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 8px;color:#9ca3af;font-size:13px">Your sign-in code</p>
      <p style="margin:0 0 4px;color:#50C878;font-size:32px;font-weight:700;letter-spacing:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</p>
      <p style="margin:0 0 24px;color:#6b7280;font-size:12px">
        Type this on the &ldquo;Check your email&rdquo; screen. Use the code if you
        added Stash to your home screen &mdash; a tapped link opens in Safari and
        won&rsquo;t sign you in there.
      </p>
      <p style="margin:0 0 12px;color:#9ca3af;font-size:13px">Or, in a browser:</p>
      <a href="${url}" style="display:inline-block;background:#50C878;color:#1A1A1A;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:6px;font-size:14px">Sign in</a>
      <p style="margin:24px 0 0;color:#6b7280;font-size:12px">
        Expires in ${minutes} minutes, single use. Not you? Ignore this email.
      </p>
    </div>
  </div>
</div>`.trim(),
          });
        },
      }),
    ],

    callbacks: {
      // With the database strategy Auth.js hands us the full adapter user
      // (it does SELECT *), so any extra column on `users` is available here
      // for free — no additional query.
      session({ session, user }) {
        if (session.user) session.user.id = user.id;
        return session;
      },
    },

    // Vercel sets the host header; trust it so callback URLs resolve correctly.
    trustHost: true,
  };
});
