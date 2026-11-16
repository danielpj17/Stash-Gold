#!/usr/bin/env node
/**
 * POST a fixture email to an ingest endpoint — the email-sync dev loop, since
 * Google's Apps Script can't reach localhost (plan §6 Phase 1).
 *
 *   STASH_TOKEN=stsh_… node scripts/post-test-email.mjs <fixture.json|dir> [baseUrl] [--keep-id]
 *
 *   baseUrl defaults to http://localhost:3000
 *   --keep-id  reuse the fixture's gmailMessageId (to test duplicate delivery);
 *              by default each run gets a fresh id so it's processed anew
 *
 * The token must be an EMAIL-sync key (Settings → Email sync), not a Shortcut
 * token: the ingest route checks the token's purpose.
 *
 * Prints only the response, never the body it sent.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const keepId = args.includes("--keep-id");
const positional = args.filter((a) => !a.startsWith("--"));
const target = positional[0];
const base = (positional[1] ?? "http://localhost:3000").replace(/\/+$/, "");
const token = process.env.STASH_TOKEN?.trim();

if (!target || !token) {
  console.error("Usage: STASH_TOKEN=stsh_… node scripts/post-test-email.mjs <fixture.json|dir> [baseUrl] [--keep-id]");
  process.exit(1);
}

function files(p) {
  if (statSync(p).isDirectory()) {
    return readdirSync(p)
      .flatMap((name) => files(path.join(p, name)))
      .filter((f) => f.endsWith(".json") && !f.endsWith(".raw.json"));
  }
  return [p];
}

for (const file of files(target)) {
  const fixture = JSON.parse(readFileSync(file, "utf8"));
  const email = { ...(fixture.email ?? fixture) };
  if (!keepId) email.gmailMessageId = `test${randomBytes(8).toString("hex")}`;
  if (!email.date) email.date = new Date().toISOString();

  const res = await fetch(`${base}/api/ingest/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(email),
  });
  const text = await res.text();
  console.log(`${path.basename(file)} → HTTP ${res.status} ${text}`);
}
