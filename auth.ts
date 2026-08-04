import NextAuth from "next-auth";
import NeonAdapter from "@auth/neon-adapter";
import Nodemailer from "next-auth/providers/nodemailer";
import { Pool, neonConfig } from "@neondatabase/serverless";

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
        maxAge: 15 * 60, // magic link validity
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
