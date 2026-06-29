import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// `tsx` binary lives in the CLI package's own devDeps (pnpm hoists off
// by default). Resolve it through the test's own __dirname so the path
// is stable across the test runner's working directory.
let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-init-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit init", () => {
  it("creates .cognit/ tree, cognit.yaml, and the .gitignore snippet", async () => {
    const { status, stdout } = runCli(tmp, ["init"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Initialised Cognit project");

    const dir = path.join(tmp, ".cognit");
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "cognit.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "inbox", "_error"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "artifacts", "curated"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "snapshots"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "archive"))).toBe(true);
  });

  it("uses --project to override the directory-derived name", async () => {
    const { status, stdout } = runCli(tmp, ["init", "--project", "cognit-fixture"]);
    expect(status).toBe(0);
    const cfg = fs.readFileSync(path.join(tmp, ".cognit", "cognit.yaml"), "utf8");
    expect(cfg).toContain("cognit-fixture");
    expect(stdout).toContain("cognit-fixture");
  });

  it("is idempotent: re-running init against an existing project exits 0", async () => {
    runCli(tmp, ["init"]);
    const second = runCli(tmp, ["init"]);
    // Init is idempotent so the docker `init` service can run on every
    // `up` without wedging the stack. The "nothing to do" message tells
    // the operator the second run was a no-op.
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already exists");
  });

  it("overwrites when --force is passed", async () => {
    runCli(tmp, ["init", "--project", "first"]);
    const second = runCli(tmp, ["init", "--project", "second", "--force"]);
    expect(second.status).toBe(0);
    const cfg = fs.readFileSync(path.join(tmp, ".cognit", "cognit.yaml"), "utf8");
    expect(cfg).toContain("second");
  });
});
