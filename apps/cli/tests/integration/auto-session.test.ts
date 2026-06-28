/**
 * apps/cli/test/auto-session.test.ts — M1.1 hardening.
 *
 * Five cases for the auto-session contract that every write verb
 * (observation / decision / conclusion / verification / append)
 * depends on:
 *
 *   1. explicit --session wins
 *   2. sticky current-session wins when explicit absent
 *   3. missing session auto-creates one and writes the pointer
 *   4. invalid current-session (id not in DB) auto-recovers
 *   5. commands work end-to-end without manual session create
 *
 * Plus: continue + search pick up the auto-created session.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

const sessionIdFromCreate = (out: string): string => {
  const m = out.match(/session:\s+(01[A-Z0-9]+)/i);
  if (!m) throw new Error(`no session id in output: ${out}`);
  return m[1]!;
};

const sessionIdFromPointer = (cwd: string): string | null => {
  const p = path.join(cwd, ".cognit", "current-session");
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8").trim();
};

const countSessions = (cwd: string): number => {
  const db = new BetterSqlite3(path.join(cwd, ".cognit", "cognit.db"));
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
};

const eventsFor = (cwd: string, sessionId: string): Array<{ type: string }> => {
  const db = new BetterSqlite3(path.join(cwd, ".cognit", "cognit.db"));
  try {
    return db
      .prepare("SELECT type FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC")
      .all(sessionId) as Array<{ type: string }>;
  } finally {
    db.close();
  }
};

/** Strip lifecycle / audit events the reducer emits internally; tests assert user-visible events. */
const userEvents = (types: ReadonlyArray<{ type: string }>): string[] =>
  types
    .map((e) => e.type)
    .filter((t) => t !== "session_created" && t !== "actor_registered");

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-auto-session-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("auto-session contract", () => {
  it("1. explicit --session wins over sticky pointer", () => {
    expect(runCli(tmp, ["init", "--project", "t"]).status).toBe(0);
    const a = runCli(tmp, ["session", "create", "first"]);
    const sidA = sessionIdFromCreate(a.stdout);
    const b = runCli(tmp, ["session", "create", "second"]);
    const sidB = sessionIdFromCreate(b.stdout);
    // Sticky pointer points at sidB (most recent create).

    const r = runCli(tmp, ["observation", "explicit wins", "--session", sidA]);
    expect(r.status).toBe(0);
    // Sticky pointer did not move (explicit is one-off).
    expect(sessionIdFromPointer(tmp)).toBe(sidB);
    // Event landed on sidA.
    expect(userEvents(eventsFor(tmp, sidA))).toContain("observation_recorded");
    expect(userEvents(eventsFor(tmp, sidB))).toHaveLength(0);
  });

  it("2. sticky pointer wins when explicit is absent", () => {
    expect(runCli(tmp, ["init", "--project", "t"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "sticky target"]);
    const sid = sessionIdFromCreate(create.stdout);

    const r = runCli(tmp, ["observation", "uses sticky"]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("created session");
    expect(sessionIdFromPointer(tmp)).toBe(sid);
    expect(userEvents(eventsFor(tmp, sid))).toEqual(["observation_recorded"]);
  });

  it("3. missing session auto-creates and writes pointer", () => {
    expect(runCli(tmp, ["init", "--project", "t"]).status).toBe(0);
    expect(sessionIdFromPointer(tmp)).toBeNull();

    const r = runCli(tmp, ["observation", "first observation in this project"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("created session");
    const sid = sessionIdFromPointer(tmp);
    expect(sid).toMatch(/^01[A-Z0-9]+$/);
    // Goal text is the observation itself (truncated to 200 chars).
    expect(r.stdout).toContain(sid!);
    expect(userEvents(eventsFor(tmp, sid!))).toEqual(["observation_recorded"]);
  });

  it("4. invalid sticky pointer (id not in DB) auto-recovers", () => {
    expect(runCli(tmp, ["init", "--project", "t"]).status).toBe(0);
    // Write a bogus pointer that no session row corresponds to.
    fs.mkdirSync(path.join(tmp, ".cognit"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".cognit", "current-session"),
      "01AAAAAAAAAAAAAAAAAAAAAAAA\n",
    );

    const r = runCli(tmp, ["observation", "recovered after bogus pointer"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("created session");
    const sid = sessionIdFromPointer(tmp);
    expect(sid).not.toBe("01AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(userEvents(eventsFor(tmp, sid!))).toEqual(["observation_recorded"]);
  });

  it("5. full flow without manual session create", () => {
    expect(runCli(tmp, ["init", "--project", "t"]).status).toBe(0);
    expect(countSessions(tmp)).toBe(0); // no session yet — auto-create on first verb

    const obs = runCli(tmp, ["observation", "auth uses refresh tokens"]);
    expect(obs.status).toBe(0);
    const dec = runCli(tmp, ["decision", "propose", "drop optimistic cache"]);
    expect(dec.status).toBe(0);
    const ver = runCli(tmp, ["verification", "run", "echo ok", "--type", "test"]);
    // verification.run may exit non-zero if the engine flag stderr text;
    // we only assert that events were recorded.
    void ver.status;

    const sid = sessionIdFromPointer(tmp);
    expect(sid).toMatch(/^01[A-Z0-9]+$/);
    expect(countSessions(tmp)).toBe(1);
    const types = userEvents(eventsFor(tmp, sid!));
    expect(types).toContain("observation_recorded");
    expect(types).toContain("decision_proposed");
    expect(types).toContain("verification_started");

    // continue picks up the session and prints useful output.
    const cont = runCli(tmp, ["continue"]);
    expect(cont.status).toBe(0);
    expect(cont.stdout).toMatch(/What was decided:|Session:/);

    // search finds the observation text.
    const search = runCli(tmp, ["search", "refresh"]);
    expect(search.status).toBe(0);
    expect(search.stdout).toMatch(/observation|goal/);
  });
});

describe("failure messages", () => {
  it("outside a Cognit project tells the user to run init", () => {
    const r = runCli(tmp, ["observation", "anything"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/cognit init/);
  });

  it("corrupt current-session pointer is ignored with a warning", () => {
    expect(runCli(tmp, ["init", "--project", "t"]).status).toBe(0);
    fs.writeFileSync(
      path.join(tmp, ".cognit", "current-session"),
      "garbage-not-a-ulid\n",
    );
    const r = runCli(tmp, ["observation", "after corrupt pointer"]);
    // Should still succeed — auto-session kicks in.
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/warning.*current-session|current-session.*not a valid session id/);
  });

  it("continue with no sessions prints an onboarding block, not an error", () => {
    expect(runCli(tmp, ["init", "--project", "t"]).status).toBe(0);
    const r = runCli(tmp, ["continue"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No memory yet|Open Claude Code/);
  });

  it("search with empty query fails with a friendly message", () => {
    expect(runCli(tmp, ["init", "--project", "t"]).status).toBe(0);
    const r = runCli(tmp, ["search", ""]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/search query cannot be empty/);
  });
});
