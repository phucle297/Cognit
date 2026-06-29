import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

describe("cognit env COGNIT_SESSION_ID", () => {
  it("is omitted from --shell output when no current-session pointer exists", () => {
    const r = runCli(tmp, ["env", "--shell"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("COGNIT_SESSION_ID");
  });

  it("exports COGNIT_SESSION_ID from .cognit/current-session when present", () => {
    // Simulate `cognit session create` having written the pointer.
    const cognitDir = path.join(tmp, ".cognit");
    fs.mkdirSync(cognitDir, { recursive: true });
    const ulid = "01J9XQ9Z4R7H3K2N5P8WVT6YBC";
    fs.writeFileSync(path.join(cognitDir, "current-session"), `${ulid}\n`, "utf8");

    const r = runCli(tmp, ["env", "--shell"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`export COGNIT_SESSION_ID="${ulid}"\n`);
    expect(r.stdout).toContain(`export COGNIT_INBOX="${tmp}/.cognit/inbox"\n`);
  });

  it("prints just the session id when queried by KEY", () => {
    const cognitDir = path.join(tmp, ".cognit");
    fs.mkdirSync(cognitDir, { recursive: true });
    const ulid = "01J9XQ9Z4R7H3K2N5P8WVT6YBD";
    fs.writeFileSync(path.join(cognitDir, "current-session"), `${ulid}\n`, "utf8");

    const r = runCli(tmp, ["env", "COGNIT_SESSION_ID"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${ulid}\n`);
  });

  it("prints an empty line for the KEY form when no session is set", () => {
    const r = runCli(tmp, ["env", "COGNIT_SESSION_ID"]);
    expect(r.status).toBe(0);
    // Empty value rather than failing — keeps scripts composable.
    expect(r.stdout).toBe("\n");
  });
});
