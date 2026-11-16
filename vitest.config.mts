import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the pure modules (email parsers, merchantKey, decide, …).
 * No database, no network: anything that needs Neon is exercised by hand via
 * scripts/post-test-email.mjs, per the repo's manual-verification convention.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    environment: "node",
  },
});
