#!/usr/bin/env node
/**
 * apps/dashboard/test/budget.mjs — build-size budget gate.
 *
 * Runs `vite build`, walks the resulting `dist/`, sums gzip sizes,
 * and exits non-zero if the total exceeds 250 KB (256000 bytes).
 *
 * Plain Node — no extra deps. Spawns `npx vite build` via the
 * shell, then reads the dist tree with fs/promises and zlib.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const CAP_BYTES = 256000; // 250 KB

console.log("[budget] running vite build...");
const build = spawnSync("npx", ["vite", "build"], {
  cwd: root,
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error(`[budget] vite build failed (status=${build.status})`);
  process.exit(build.status ?? 1);
}

async function walk(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const files = await walk(distDir);
const rows = [];
let totalRaw = 0;
let totalGzip = 0;
for (const f of files) {
  const buf = await fs.readFile(f);
  const gz = gzipSync(buf, { level: 9 });
  const rel = path.relative(distDir, f);
  rows.push({ file: rel, raw: buf.length, gzip: gz.length });
  totalRaw += buf.length;
  totalGzip += gz.length;
}

rows.sort((a, b) => b.gzip - a.gzip);
console.log("\n[budget] file                               raw        gzip");
console.log("[budget] -------------------------------- ---------- ----------");
for (const r of rows) {
  console.log(`[budget] ${r.file.padEnd(36)} ${String(r.raw).padStart(10)} ${String(r.gzip).padStart(10)}`);
}
console.log("[budget] -------------------------------- ---------- ----------");
console.log(`[budget] TOTAL                              ${String(totalRaw).padStart(10)} ${String(totalGzip).padStart(10)}`);
console.log(`[budget] cap = ${CAP_BYTES} bytes (250 KB)`);

if (totalGzip > CAP_BYTES) {
  console.error(`[budget] FAIL: ${totalGzip} bytes gzip > ${CAP_BYTES} bytes`);
  process.exit(1);
}
console.log("[budget] PASS");
