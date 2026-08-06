/**
 * Sign-in codes for the "type it into the app" flow.
 *
 * An installed PWA on iOS has its own cookie jar, separate from Safari. A magic
 * link opens in Safari, so the session cookie lands there and the home-screen
 * app stays signed out — with no way to transfer it. Emailing a code the user
 * types *inside* the app creates the session in the app's own jar instead.
 *
 * The code IS the Auth.js verification token, so it goes through exactly the
 * same single-use, 15-minute, hashed-at-rest path as the link. No second
 * credential and no second code path to get wrong.
 */

/**
 * Excludes 0, O, 1 and I — the pairs people actually mistype reading a code off
 * a screen. L is kept deliberately: it's only confusable with 1 and I, and
 * neither is in the set. 32 characters exactly.
 */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const LENGTH = 8;

/**
 * 32^8 ≈ 1.1e12 possibilities. Worth being deliberate about: a 6-digit numeric
 * code would be only 1e6, which is brute-forceable against an endpoint with no
 * attempt limiting. Eight characters stays easy to thumb-type while leaving no
 * realistic guessing margin within the 15-minute window.
 */
export function generateSignInCode(randomInt: (max: number) => number): string {
  let out = "";
  for (let i = 0; i < LENGTH; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** `k7m2-9xqp` / `K7M2 9XQP` / `K7M29XQP` all normalize to the stored token. */
export function normalizeSignInCode(raw: string): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
}

/** Display form: `K7M2-9XQP`, easier to read back than one run of eight. */
export function formatSignInCode(code: string): string {
  const clean = normalizeSignInCode(code);
  return clean.length === LENGTH ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export const SIGN_IN_CODE_LENGTH = LENGTH;
