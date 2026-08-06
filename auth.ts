import { randomInt } from "crypto";
import NextAuth from "next-auth";
import NeonAdapter from "@auth/neon-adapter";
import Nodemailer from "next-auth/providers/nodemailer";
import nodemailer from "nodemailer";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { formatSignInCode, generateSignInCode } from "@/lib/signInCode";
import { renderSignInEmail } from "@/lib/signInEmail";

/**
 * The adapter only ever calls `pool.query(sql, params)` â€” never `connect()`,
 * never BEGIN â€” and registers no pool lifecycle listeners. That is exactly the
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
    // rolled forward at most once a day per user rather than on every request â€”
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

          const { subject, text, html } = renderSignInEmail({ code, url, minutes });
          await transport.sendMail({ to: identifier, from: provider.from, subject, text, html });
        },
      }),
    ],

    callbacks: {
      // With the database strategy Auth.js hands us the full adapter user
      // (it does SELECT *), so any extra column on `users` is available here
      // for free â€” no additional query.
      session({ session, user }) {
        if (session.user) session.user.id = user.id;
        return session;
      },
    },

    // Vercel sets the host header; trust it so callback URLs resolve correctly.
    trustHost: true,
  };
});
