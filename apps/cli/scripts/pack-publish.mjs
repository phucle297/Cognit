#!/usr/bin/env node
/**
 * Prepare a publishable tarball for @cognit/cli (D-M2-04).
 *
 * Monorepo `package.json` keeps `workspace:*` deps for development.
 * The published artifact only needs the tsup bundle (`dist/`) plus
 * real npm dependencies (better-sqlite3, commander, effect, …).
 *
 * Usage:
 *   node scripts/pack-publish.mjs           # write pack/ and npm pack
 *   node scripts/pack-publish.mjs --smoke   # also install + init + observation
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(__dirname, "..");
const smoke = process.argv.includes("--smoke");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? cliRoot,
    encoding: "utf8",
    stdio: opts.stdio ?? "pipe",
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (r.status !== 0) {
    process.stderr.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    throw new Error(`${cmd} ${args.join(" ")} failed with ${r.status}`);
  }
  return r;
}

// 1. Build (tsup + copy migrations into dist/).
process.stdout.write("→ build @cognit/cli\n");
run("pnpm", ["run", "build"], { stdio: "inherit" });

const distDir = path.join(cliRoot, "dist");
if (!fs.existsSync(path.join(distDir, "index.js"))) {
  throw new Error("dist/index.js missing after build");
}
if (!fs.existsSync(path.join(distDir, "migrations"))) {
  throw new Error("dist/migrations missing after build");
}

// 2. Publish-shaped package.json (no workspace: deps).
const srcPkg = JSON.parse(
  fs.readFileSync(path.join(cliRoot, "package.json"), "utf8"),
);
const publishPkg = {
  name: srcPkg.name,
  version: srcPkg.version,
  description:
    srcPkg.description ??
    "Cognit CLI — local-first memory for AI-assisted engineering",
  type: "module",
  bin: srcPkg.bin,
  files: ["dist"],
  engines: srcPkg.engines ?? { node: ">=22.0.0" },
  license: srcPkg.license ?? "MIT",
  repository: srcPkg.repository,
  keywords: srcPkg.keywords ?? ["cognit", "cli", "local-first", "ai"],
  // Runtime-only: tsup already inlined @cognit/* into dist/index.js.
  dependencies: {
    "better-sqlite3": srcPkg.dependencies["better-sqlite3"],
    chokidar: srcPkg.dependencies.chokidar,
    commander: srcPkg.dependencies.commander,
    effect: srcPkg.dependencies.effect,
    tar: srcPkg.dependencies.tar,
    yaml: srcPkg.dependencies.yaml,
  },
};

const packDir = path.join(cliRoot, ".pack-staging");
fs.rmSync(packDir, { recursive: true, force: true });
fs.mkdirSync(packDir, { recursive: true });
fs.writeFileSync(
  path.join(packDir, "package.json"),
  JSON.stringify(publishPkg, null, 2) + "\n",
);
// Copy dist tree.
run("cp", ["-R", distDir, path.join(packDir, "dist")]);
// Optional README for npm page.
const readme = path.join(cliRoot, "../../README.md");
if (fs.existsSync(readme)) {
  fs.copyFileSync(readme, path.join(packDir, "README.md"));
}

process.stdout.write("→ npm pack\n");
const packOut = run("npm", ["pack", "--pack-destination", cliRoot], {
  cwd: packDir,
});
const tarballName = packOut.stdout.trim().split("\n").pop();
const tarballPath = path.join(cliRoot, tarballName);
process.stdout.write(`✓ packed ${tarballPath}\n`);

if (!smoke) {
  process.exit(0);
}

// 3. Smoke: install tarball in clean dir, run init + observation.
process.stdout.write("→ smoke install + init + observation\n");
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cognit-pack-smoke-"));
const installDir = path.join(smokeRoot, "install");
const projectDir = path.join(smokeRoot, "project");
fs.mkdirSync(installDir);
fs.mkdirSync(projectDir);

run("npm", ["init", "-y"], { cwd: installDir });
run("npm", ["install", tarballPath], { cwd: installDir, stdio: "inherit" });

const cognitBin = path.join(installDir, "node_modules", ".bin", "cognit");
if (!fs.existsSync(cognitBin)) {
  throw new Error(`cognit bin missing at ${cognitBin}`);
}

const init = spawnSync(cognitBin, ["init", "--project", "pack-smoke"], {
  cwd: projectDir,
  encoding: "utf8",
});
if (init.status !== 0) {
  process.stderr.write(init.stdout + init.stderr);
  throw new Error(`cognit init failed: ${init.status}`);
}

const obs = spawnSync(
  cognitBin,
  ["observation", "pack smoke observation"],
  { cwd: projectDir, encoding: "utf8" },
);
if (obs.status !== 0) {
  process.stderr.write(obs.stdout + obs.stderr);
  throw new Error(`cognit observation failed: ${obs.status}`);
}

process.stdout.write(`✓ smoke ok (project=${projectDir})\n`);
fs.rmSync(smokeRoot, { recursive: true, force: true });
// Keep tarball for inspection; staging can go.
fs.rmSync(packDir, { recursive: true, force: true });
