import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkDkim } from "@/lib/email/dkim";
import { normalizeEmail } from "@/lib/email/normalize";
import { partId } from "@/lib/email/parts";
import { validateEmailPayload } from "@/lib/email/payload";
import { parserForSender } from "@/lib/email/registry";

/**
 * One test per fixture under __fixtures__/<parser>/<case>.json (plan §5.3).
 *
 * Fixture shape:
 *   {
 *     "synthetic": true,            // written by hand, not exported from real mail
 *     "note": "what this case covers",
 *     "email": { …the poller payload… },
 *     "expect": { "alert": {…partial ParsedAlert…} }
 *            | { "ignore": "reason" } | { "unparsed": true }
 *            | { "unauthenticated": true } | { "noParser": true }
 *            | { "parts": [{…partial ParsedAlert…}, …] }   // a summary: splits,
 *              and part k (`<id>#k`, lib/email/parts.ts) reads as item k
 *   }
 *
 * Real exports come from scripts/export-email-fixture.mjs (scrubbed).
 * Unscrubbed `*.raw.json` files are gitignored and skipped here.
 */

type Fixture = {
  synthetic?: boolean;
  note?: string;
  email: unknown;
  expect:
    | { alert: Record<string, unknown> }
    | { ignore: string }
    | { unparsed: true }
    | { unauthenticated: true }
    | { noParser: true }
    | { parts: Array<Record<string, unknown>> };
};

const ROOT = path.join(__dirname, "__fixtures__");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".json") && !name.endsWith(".raw.json")) out.push(full);
  }
  return out;
}

const files = walk(ROOT);

describe("parser fixtures", () => {
  it("has fixtures", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;

    it(`${rel}${fixture.note ? ` — ${fixture.note}` : ""}`, () => {
      const payload = validateEmailPayload(fixture.email);
      if ("error" in payload) throw new Error(`fixture payload invalid: ${payload.error}`);
      const email = normalizeEmail(payload);
      const parser = parserForSender(email);

      if ("noParser" in fixture.expect) {
        expect(parser).toBeNull();
        return;
      }
      expect(parser, "no parser matched the sender").not.toBeNull();
      if (!parser) return;
      expect(parser.id).toBe(rel.split("/")[0]);

      const dkim = checkDkim(email.authResults, email.arcAuthResults, parser.dkimDomains);
      if ("unauthenticated" in fixture.expect) {
        expect(dkim.pass).toBe(false);
        return;
      }
      if (parser.requireDkim !== false) expect(dkim.pass, "DKIM should pass").toBe(true);

      const result = parser.parse(email);
      if ("unparsed" in fixture.expect) {
        expect(result).toHaveProperty("unparsed");
      } else if ("ignore" in fixture.expect) {
        expect(result).toMatchObject({ ignore: fixture.expect.ignore });
      } else if ("alert" in fixture.expect) {
        expect(result).toMatchObject(fixture.expect.alert);
      } else if ("parts" in fixture.expect) {
        const parts = fixture.expect.parts;
        expect(result).toEqual({ split: parts.length });
        parts.forEach((want, i) => {
          const part = parser.parse(normalizeEmail({ ...payload, gmailMessageId: partId(payload.gmailMessageId, i + 1) }));
          expect(part, `part ${i + 1}`).toMatchObject(want);
        });
        // One past the end is never a guess.
        const past = parser.parse(normalizeEmail({ ...payload, gmailMessageId: partId(payload.gmailMessageId, parts.length + 1) }));
        expect(past).toHaveProperty("unparsed");
      }
    });
  }
});
