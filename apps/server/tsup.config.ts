import { defineConfig } from "tsup";

/**
 * Server tsup config — used by `pnpm --filter @cognit/server build` and
 * the production Docker build (docker/Dockerfile.server).
 *
 * Bundles the workspace TS-source deps (@cognit/core, @cognit/db,
 * @cognit/verification) into a single ESM file so the runtime image
 * only needs `dist/index.js` + a node_modules subset of the real
 * native / 3rd-party deps (better-sqlite3, hono, effect, etc.).
 *
 * Native bindings and pure-Node runtime deps stay external so they
 * are required at runtime the way Node expects (no bundler shims).
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  clean: true,
  dts: false,
  sourcemap: true,
  // tsup defaults to externalizing all `node_modules` (and therefore
  // pnpm-symlinked workspace packages). Flip the default: bundle
  // every workspace package, then re-externalize the native +
  // 3rd-party runtime deps that must stay as runtime `require()`s.
  noExternal: [/^@cognit\//],
  external: [
    "better-sqlite3",
    "hono",
    "@hono/node-server",
    "@hono/cookie",
    "commander",
    "effect",
    "ulid",
  ],
});
