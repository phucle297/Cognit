/**
 * apps/cli/test/recovery-wiring.test.ts — CLI-level smoke tests
 * for the recovery command wiring. Avoids the Hono server: the
 * commands that need HTTP fail fast with a clean error, and the
 * server-less paths are exercised end-to-end via `spawnSync`.
 *
 * Integration coverage for the actual HTTP requests lives in the
 * server-side route tests.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(cwd: string, args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      // Point at an unreachable port so HTTP fetches fail fast
      // without spawning the server. The format-function unit
      // tests cover the success path; this test only verifies
      // the command is wired into the CLI and exits non-zero.
      COGNIT_SERVER_URL: "http://127.0.0.1:1",
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-recov-wiring-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit recovery CLI wiring", () => {
  it("cognit recovery --help lists both subcommands", () => {
    const r = runCli(tmp, ["recovery", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/search \[options\] <query>/);
    // The session-id subcommand registers as `<session-id>` in
    // the help output.
    expect(r.stdout).toMatch(/<session-id>/);
  });

  it("cognit recovery <unknown-id> with no server exits non-zero (AC-7.15)", () => {
    // No `init` needed — the command hits HTTP before it touches
    // the local DB, and the unreachable URL fails the fetch.
    const r = runCli(tmp, ["recovery", "01HZZZZZZZZZZZZZZZZZZZZZZ"]);
    expect(r.status).not.toBe(0);
  });

  it("cognit recovery search <q> with no server exits non-zero", () => {
    const r = runCli(tmp, ["recovery", "search", "anything"]);
    expect(r.status).not.toBe(0);
  });

  it("cognit session resume --search with no server exits non-zero", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    expect(runCli(tmp, ["session", "create", "anything"]).status).toBe(0);
    const r = runCli(tmp, ["session", "resume", "ignored", "--search", "anything"]);
    expect(r.status).not.toBe(0);
  });
});