// apps/cli/tsup.config.ts
//
// CLI bundle config. Used by:
//   - pnpm --filter @cognit/cli build
//   - the prepare lifecycle hook (pnpm link --global)
//
// Goal: produce a single dist/index.js that the linked "cognit"
// binary can run from any cwd WITHOUT a tsx loader. Workspace
// packages (@cognit/*) ship as raw TS source and use .js import
// specifiers (NodeNext style) that plain Node ESM cannot rewrite.
// We inline the workspace packages into the bundle and keep the
// native binding + a few packages that need dynamic require as
// external runtime requires.

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  shims: true,
  clean: true,
  dts: false,
  sourcemap: true,
  // Bundle every workspace package so the linked binary needs no
  // tsx loader at runtime.
  noExternal: [/^@cognit\//],
  // Re-externalize the native binding + packages that depend on
  // dynamic require resolution. These are resolved from the
  // runtime node_modules tree.
  external: [
    "better-sqlite3",
    "chokidar",
    "commander",
    "effect",
    "tar",
    "yaml",
  ],
  // Inject the shebang on every rebuild so the linked cognit
  // binary runs as node dist/index.js when invoked from any cwd.
  banner: { js: "#!/usr/bin/env node" },
});
