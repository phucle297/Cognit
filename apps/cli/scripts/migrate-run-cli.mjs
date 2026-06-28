#!/usr/bin/env node
/**
 * Migrate test files: replace per-file runCli with shared helper.
 *
 *   1. Strip `const CLI_ENTRY = ...` and `const TSX = ...` lines.
 *   2. Strip the `function runCli(...) { ... }` block.
 *   3. Insert `import { runCli } from "../helpers/run-cli";` after the
 *      `from "vitest"` import.
 *
 * Idempotent: re-running on an already-migrated file is a no-op because
 * the patterns are absent.
 *
 * Only processes integration/ and e2e/ — unit/ files never had a local
 * runCli and must not pick up the import.
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["tests/integration", "tests/e2e"];

function stripRunCli(src) {
  // Match the whole `function runCli(...) { ... }` block. The body
  // closing `}` is anchored to start-of-line so we don't accidentally
  // close on a brace inside an object literal that isn't the function
  // body.
  const re = /^function runCli\b[\s\S]*?\n\}\n/m;
  const m = src.match(re);
  if (!m) return { out: src, changed: false };
  const startIdx = m.index;
  let endIdx = startIdx + m[0].length;
  // Eat one extra trailing newline if present.
  if (src[endIdx] === "\n") endIdx++;
  // Also eat a leading blank line so we don't leave two blank lines.
  let cutFrom = startIdx;
  if (cutFrom > 0 && src[cutFrom - 1] === "\n") cutFrom--;
  return {
    out: src.slice(0, cutFrom) + src.slice(endIdx),
    changed: true,
  };
}

function migrate(file) {
  const src = fs.readFileSync(file, "utf8");
  let out = src;
  let changed = false;

  // 1. Strip TSX / CLI_ENTRY const lines.
  const stripped = out.replace(/^const (CLI_ENTRY|TSX) = .*;\n/gm, "");
  if (stripped !== out) {
    out = stripped;
    changed = true;
  }

  // 2. Strip the runCli function.
  const r = stripRunCli(out);
  if (r.changed) {
    out = r.out;
    changed = true;
  }

  // 3. Insert the helper import after the vitest import.
  if (!out.includes('from "../helpers/run-cli"')) {
    const m = out.match(/^(import .+ from "vitest";\n)/m);
    if (m) {
      out =
        out.slice(0, m.index + m[0].length) +
        'import { runCli } from "../helpers/run-cli";\n' +
        out.slice(m.index + m[0].length);
      changed = true;
    }
  }

  // 4. Collapse 3+ blank lines left by deletions.
  const collapsed = out.replace(/\n{3,}/g, "\n\n");
  if (collapsed !== out) {
    out = collapsed;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, out);
    console.log("migrated:", path.relative(process.cwd(), file));
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) migrate(full);
  }
}

for (const t of ROOTS) walk(path.resolve(t));