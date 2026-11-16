/**
 * Turn a real stored alert into a scrubbed parser fixture (plan §5.3).
 *
 *   npm run email:export -- <gmail_message_id> [--parser venmo] [--case purchase-1]
 *
 * Reads email_events (DATABASE_URL from env / .env.local), scrubs it —
 * email addresses, personal names in From/To, street addresses and balances
 * become placeholders; every real last-4 maps to a stable FAKE last-4 — prints
 * what it changed for you to eyeball, and writes:
 *
 *   lib/email/parsers/__fixtures__/<parser>/<case>.json      scrubbed, commit it
 *   lib/email/parsers/__fixtures__/<parser>/<case>.raw.json  UNSCRUBBED, gitignored
 *
 * `expect` is pre-filled with what the CURRENT parser produces (with the same
 * scrubbing applied), so check it by hand before committing — a fixture that
 * just records today's bug is worse than none.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { normalizeEmail } from "@/lib/email/normalize";
import { validateEmailPayload } from "@/lib/email/payload";
import { parserById, parserForSender } from "@/lib/email/registry";

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env.local", ".env"]) {
    try {
      const m = readFileSync(file, "utf8").match(/^DATABASE_URL[ \t]*=[ \t]*(.*)$/m);
      if (m?.[1].trim()) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      /* next */
    }
  }
  throw new Error("DATABASE_URL is not set (checked env, .env.local, .env)");
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const gmailId = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!gmailId) {
  console.error("Usage: npm run email:export -- <gmail_message_id> [--parser id] [--case name]");
  process.exit(1);
}

const changes: string[] = [];
const fakeLast4 = (real: string) => {
  const n = parseInt(createHash("sha256").update(`last4:${real}`).digest("hex").slice(0, 6), 16) % 10000;
  return String(n).padStart(4, "0");
};

function scrub(text: string | null): string | null {
  if (!text) return text;
  let s = text;
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => {
    // Keep the sender domain's alert address shape for routing; mask people.
    if (/^(no-?reply|alerts?|notifications?|venmo|service|customerservice)/i.test(m)) return m;
    changes.push(`email ${m}`);
    return "person@example.com";
  });
  s = s.replace(/(ending(?:\s+in)?\s*|[*•x.…]{2,}\s?)(\d{4})\b/gi, (_m, pre: string, d: string) => {
    const fake = fakeLast4(d);
    changes.push(`last4 ${d} → ${fake}`);
    return `${pre}${fake}`;
  });
  s = s.replace(
    /\b\d{2,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ln|Lane|Ct|Way|Pkwy)\b\.?/g,
    (m) => {
      changes.push(`address ${m}`);
      return "123 Example St";
    },
  );
  s = s.replace(/((?:available|current|new|ending)\s+balance[^$\n]{0,40})\$\s?[\d,]+(?:\.\d{2})?/gi, (m, pre: string) => {
    changes.push(`balance ${m.trim()}`);
    return `${pre}$1,000.00`;
  });
  return s;
}

function scrubName(header: string | null): string | null {
  if (!header) return header;
  return header.replace(/^\s*"?([^"<]+?)"?\s*</, (m, name: string) => {
    if (/bank|card|venmo|alert|chase|service/i.test(name)) return m;
    changes.push(`name ${name.trim()}`);
    return "Person <";
  });
}

const sql = neon(databaseUrl());
const rows = (await sql`
  SELECT gmail_message_id, from_address, to_address, forwarded_for, subject, received_at,
         auth_results, arc_auth_results, raw_text, raw_html, truncated, parser_id
    FROM email_events WHERE gmail_message_id = ${gmailId}
`) as Array<Record<string, unknown>>;
if (rows.length !== 1) {
  console.error(rows.length === 0 ? "No such event." : "That id exists in more than one scope; refusing to guess.");
  process.exit(1);
}
const ev = rows[0];

const raw = {
  gmailMessageId: String(ev.gmail_message_id),
  from: String(ev.from_address),
  to: (ev.to_address as string | null) ?? null,
  subject: String(ev.subject ?? ""),
  date: new Date(String(ev.received_at)).toISOString(),
  plainBody: String(ev.raw_text ?? ""),
  htmlBody: String(ev.raw_html ?? ""),
  truncated: ev.truncated === true,
  headers: {
    "X-Forwarded-For": (ev.forwarded_for as string | null) ?? null,
    "Authentication-Results": (ev.auth_results as string | null) ?? null,
    "ARC-Authentication-Results": (ev.arc_auth_results as string | null) ?? null,
  },
};

const scrubbed = {
  ...raw,
  gmailMessageId: "fixture0000000001",
  from: scrubName(raw.from) ?? raw.from,
  to: "stash.inbox@example.com",
  subject: scrub(raw.subject) ?? "",
  plainBody: scrub(raw.plainBody) ?? "",
  htmlBody: scrub(raw.htmlBody) ?? "",
  headers: {
    ...raw.headers,
    "X-Forwarded-For": raw.headers["X-Forwarded-For"] ? "person@example.com" : null,
  },
};

const payload = validateEmailPayload(scrubbed);
if ("error" in payload) throw new Error(payload.error);
const email = normalizeEmail(payload);
const parser = parserById(flag("parser") ?? (ev.parser_id as string | null)) ?? parserForSender(email);
const parserDir = parser?.id ?? "_unknown";
let expectation: Record<string, unknown> = { noParser: true };
if (parser) {
  const result = parser.parse(email);
  expectation = "unparsed" in result ? { unparsed: true } : "ignore" in result ? { ignore: result.ignore } : { alert: result };
}

const caseName = flag("case") ?? `${new Date(raw.date).toISOString().slice(0, 10)}-${gmailId.slice(-6)}`;
const dir = path.join("lib", "email", "parsers", "__fixtures__", parserDir);
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, `${caseName}.raw.json`), JSON.stringify({ email: raw }, null, 2) + "\n");
writeFileSync(
  path.join(dir, `${caseName}.json`),
  JSON.stringify({ note: "exported from a real alert — CHECK `expect` BY HAND", email: scrubbed, expect: expectation }, null, 2) + "\n",
);

console.log(`Scrubbed ${changes.length} item(s):`);
for (const c of [...new Set(changes)]) console.log(`  - ${c}`);
console.log(`\nWrote ${path.join(dir, `${caseName}.json`)} (commit after checking)`);
console.log(`Wrote ${path.join(dir, `${caseName}.raw.json`)} (gitignored — never commit)`);
