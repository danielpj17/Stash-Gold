/**
 * Module augmentation for the two extra `users` columns the app reads.
 *
 * `session.user.id` was already assigned in auth.ts and happened to typecheck
 * against the library's own optional `id`; `dataOwnerId` does not, so both the
 * session shape and the adapter's user shape are declared here.
 *
 * The adapter does `SELECT *`, so `AdapterUser` genuinely carries every column
 * on `users` at runtime — the snake_case name below is the real column name as
 * it arrives, unmapped.
 */
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      /**
       * The household owner whose data this user sees, or null when they own
       * their own. Resolved into `ApiUser.userId` by requireUser().
       */
      dataOwnerId: string | null;
    } & DefaultSession["user"];
  }
}

declare module "@auth/core/adapters" {
  interface AdapterUser {
    /** Raw column off `users`, as the adapter's SELECT * returns it. */
    data_owner_id?: string | null;
  }
}
