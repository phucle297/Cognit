import { defineConfig } from "vitest/config";

/**
 * Vitest config — apps/cli.
 *
 * Three test projects, run by tier:
 *
 *   unit:        pure modules, no child process. Default-fast.
 *   integration: spawns `node dist/index.js` against a tempdir project.
 *                Requires a built `dist/` (the package scripts run
 *                `pnpm build` before this tier).
 *   e2e:         full server + watch + import/export flows. Slowest,
 *                gated behind RUN_E2E / RUN_AGENT_E2E.
 *
 * Default `pnpm test` runs unit + integration. `pnpm test:ci` runs all
 * three. Tier timeout is 30s because spawning a commander/drizzle
 * child still pays ~250ms cold-start per call; integration tests
 * occasionally do 3-5 spawns in sequence.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          exclude: ["node_modules", "dist"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          exclude: ["node_modules", "dist"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          exclude: ["node_modules", "dist"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});