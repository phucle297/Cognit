import { defineConfig } from "vitest/config";

/**
 * Vitest config — apps/cli.
 *
 * Test timeout bumped to 30s because `runCli` spawns `tsx` per call,
 * and the full CLI cold-start (commander 15, better-sqlite3 12, drizzle
 * 0.45, effect 3.21) is now north of the 5s default.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
