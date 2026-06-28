import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearCurrentSession,
  readCurrentSession,
  writeCurrentSession,
} from "../../src/current-session.js";
import { projectPaths } from "../../src/paths.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-sticky-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("current-session pointer (file-level)", () => {
  it("writeCurrentSession creates .cognit/current-session with the given id", () => {
    writeCurrentSession(tmp, "01ABCDEFGHJKMNP00000000000");
    const paths = projectPaths(tmp);
    expect(fs.existsSync(paths.currentSession)).toBe(true);
    const content = fs.readFileSync(paths.currentSession, "utf8").trim();
    expect(content).toBe("01ABCDEFGHJKMNP00000000000");
  });

  it("writeCurrentSession is atomic — no .tmp file remains after success", () => {
    writeCurrentSession(tmp, "01ABCDEFGHJKMNP00000000001");
    const paths = projectPaths(tmp);
    expect(fs.existsSync(paths.currentSessionTmp)).toBe(false);
  });

  it("readCurrentSession returns null when the pointer file is absent", () => {
    expect(readCurrentSession(tmp)).toBeNull();
  });

  it("readCurrentSession returns the id and stale=false for a fresh write", () => {
    writeCurrentSession(tmp, "01ABCDEFGHJKMNP00000000002");
    const r = readCurrentSession(tmp);
    expect(r).not.toBeNull();
    expect(r?.sessionId).toBe("01ABCDEFGHJKMNP00000000002");
    expect(r?.stale).toBe(false);
  });

  it("readCurrentSession sets stale=true when mtime is older than 24h", () => {
    writeCurrentSession(tmp, "01ABCDEFGHJKMNP00000000003");
    const paths = projectPaths(tmp);
    // Backdate the mtime to 25h ago.
    const old = Date.now() - 25 * 60 * 60 * 1000;
    fs.utimesSync(paths.currentSession, old / 1000, old / 1000);
    const r = readCurrentSession(tmp);
    expect(r?.stale).toBe(true);
  });

  it("clearCurrentSession removes the pointer; reading then returns null", () => {
    writeCurrentSession(tmp, "01ABCDEFGHJKMNP00000000004");
    expect(readCurrentSession(tmp)).not.toBeNull();
    clearCurrentSession(tmp);
    expect(readCurrentSession(tmp)).toBeNull();
  });

  it("clearCurrentSession is idempotent on a missing file", () => {
    expect(() => clearCurrentSession(tmp)).not.toThrow();
  });
});

describe("cognit session create / close drives the pointer", () => {
  it("session create writes the pointer; session close clears it", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);

    const create = runCli(tmp, ["session", "create", "investigate"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;
    const r1 = readCurrentSession(tmp);
    expect(r1?.sessionId).toBe(sessionId);

    const close = runCli(tmp, ["session", "close", sessionId]);
    expect(close.status).toBe(0);
    expect(readCurrentSession(tmp)).toBeNull();
  });

  it("subsequent cognit append without --session lands in the sticky session", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "investigate"]);
    expect(create.status).toBe(0);

    // No --session: should use the pointer.
    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"from sticky pointer"}',
    ]);
    expect(append.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const sessionId = idMatch![1]!;
    expect(append.stdout).toContain(`session:  ${sessionId}`);
  });

  it("explicit --session overrides the pointer silently", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const a = runCli(tmp, ["session", "create", "session A"]);
    expect(a.status).toBe(0);
    const idA = (a.stdout.match(/session:\s+(01[A-Z0-9]+)/i) as RegExpMatchArray)[1]!;
    const b = runCli(tmp, ["session", "create", "session B"]);
    expect(b.status).toBe(0);
    // pointer now points at B; explicit --session=A wins.
    const append = runCli(tmp, [
      "append",
      "--session",
      idA,
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"to A"}',
    ]);
    expect(append.status).toBe(0);
    expect(append.stdout).toContain(`session:  ${idA}`);
  });

  it("stale pointer (mtime > 24h) prints a warning but does not error", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "x"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const sessionId = idMatch![1]!;
    // Backdate the pointer to 25h ago.
    const paths = projectPaths(tmp);
    const old = Date.now() - 25 * 60 * 60 * 1000;
    fs.utimesSync(paths.currentSession, old / 1000, old / 1000);

    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"y"}',
    ]);
    // Stale pointer is a WARNING, not an error.
    expect(append.status).toBe(0);
    expect(append.stderr).toMatch(/warning.*sticky session pointer/i);
    expect(append.stdout).toContain(`session:  ${sessionId}`);
  });

  it("concurrent writers race: two session create calls in parallel both succeed and the file is one of the two values", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const a = runCli(tmp, ["session", "create", "parallel A"]);
    const b = runCli(tmp, ["session", "create", "parallel B"]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const idA = (a.stdout.match(/session:\s+(01[A-Z0-9]+)/i) as RegExpMatchArray)[1]!;
    const idB = (b.stdout.match(/session:\s+(01[A-Z0-9]+)/i) as RegExpMatchArray)[1]!;
    const final = readCurrentSession(tmp);
    expect(final).not.toBeNull();
    // Last-writer-wins: the file is one of the two ids.
    expect([idA, idB]).toContain(final!.sessionId);
  });
});
