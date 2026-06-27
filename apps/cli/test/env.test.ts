import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-env-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit env --shell", () => {
  it("prints an eval-able export line for COGNIT_INBOX", () => {
    const r = runCli(tmp, ["env", "--shell"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`export COGNIT_INBOX="${tmp}/.cognit/inbox"\n`);
  });

  it("does not create .cognit/ as a side effect", () => {
    runCli(tmp, ["env", "--shell"]);
    expect(fs.existsSync(path.join(tmp, ".cognit"))).toBe(false);
  });

  it("does not write to the database", () => {
    runCli(tmp, ["env", "--shell"]);
    expect(fs.existsSync(path.join(tmp, ".cognit", "cognit.db"))).toBe(false);
  });
});

describe("cognit env (no flag)", () => {
  it("prints a readable table", () => {
    const r = runCli(tmp, ["env"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("COGNIT_INBOX");
    expect(r.stdout).toContain(`${tmp}/.cognit/inbox`);
    // The header + separator are emitted before any row.
    expect(r.stdout).toContain("VALUE");
  });
});

describe("cognit env KEY", () => {
  it("prints just the value, one line", () => {
    const r = runCli(tmp, ["env", "COGNIT_INBOX"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${tmp}/.cognit/inbox\n`);
  });

  it("exits 1 for an unknown key and writes to stderr", () => {
    const r = runCli(tmp, ["env", "COGNIT_NOT_A_REAL_VAR"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown env key");
  });
});

describe("cognit env --root <path>", () => {
  it("resolves the inbox from --root, not cwd", () => {
    const otherRoot = path.join(tmp, "alt");
    fs.mkdirSync(otherRoot, { recursive: true });
    const r = runCli(otherRoot, ["env", "--root", otherRoot, "--shell"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`export COGNIT_INBOX="${otherRoot}/.cognit/inbox"\n`);
  });

  it("subcommand-level --root works after the positional KEY", () => {
    const otherRoot = path.join(tmp, "alt2");
    fs.mkdirSync(otherRoot, { recursive: true });
    const r = runCli(otherRoot, ["env", "COGNIT_INBOX", "--root", otherRoot]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${otherRoot}/.cognit/inbox\n`);
  });

  it("subcommand-level --root works for the no-flag table form", () => {
    const otherRoot = path.join(tmp, "alt3");
    fs.mkdirSync(otherRoot, { recursive: true });
    const r = runCli(otherRoot, ["env", "--root", otherRoot]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${otherRoot}/.cognit/inbox`);
  });
});
