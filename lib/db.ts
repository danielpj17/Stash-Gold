import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/** Tagged-template Neon client. Also exposes `.transaction([...])`. */
export type Sql = NeonQueryFunction<false, false>;

let cached: Sql | null = null;

/**
 * The one Neon client for the whole app.
 *
 * `neon()` is stateless — each tagged-template call is an independent HTTP
 * request — so caching the client at module scope is safe and avoids
 * reconstructing it dozens of times per cold start.
 *
 * Throws when DATABASE_URL is unset. Route handlers should not call this
 * directly; go through `requireUser()` in lib/apiAuth.ts, which turns a
 * missing DATABASE_URL into a 503 before touching the database.
 */
export function getSql(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  if (!cached) cached = neon(url);
  return cached;
}
