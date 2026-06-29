import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli, CLI_BIN } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-events-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

const sessionIdOf = (stdout: string): string => {
  const m = stdout.match(/session:\s+(01[A-Z0-9]+)/i);
  if (!m) throw new Error(`no session id in output: ${stdout}`);
  return m[1]!;
};

const setupWithEvents = (): { sessionId: string; cwd: string } => {
  expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
  const create = runCli(tmp, ["session", "create", "events test"]);
  expect(create.status).toBe(0);
  const sessionId = sessionIdOf(create.stdout);
  // Append three different event types so the list/filter tests have
  // real rows to operate on.
  for (const text of ["first observation", "second observation"]) {
    const r = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      JSON.stringify({ text }),
      "--session",
      sessionId,
    ]);
    expect(r.status).toBe(0);
  }
  const f = runCli(tmp, [
    "append",
    "--type",
    "finding_created",
    "--payload",
    JSON.stringify({ text: "a finding", related_observation_ids: [] }),
    "--session",
    sessionId,
  ]);
  expect(f.status).toBe(0);
  return { sessionId, cwd: tmp };
};

describe("cognit events", () => {
  it("lists all events for a session as a text table (incl. session_created)", () => {
    const { sessionId } = setupWithEvents();
    const r = runCli(tmp, ["events", "--session", sessionId]);
    expect(r.status).toBe(0);
    // Header line.
    expect(r.stdout).toMatch(/^id\s+type\s+created_at$/m);
    // All three appended types are present.
    expect(r.stdout).toMatch(/observation_recorded/);
    expect(r.stdout).toMatch(/finding_created/);
    // The auto-emitted session_created is also included in the log.
    expect(r.stdout).toMatch(/session_created/);
  });

  it("filters by --type", () => {
    const { sessionId } = setupWithEvents();
    const r = runCli(tmp, ["events", "--session", sessionId, "--type", "observation_recorded"]);
    expect(r.status).toBe(0);
    // Header still printed.
    expect(r.stdout).toMatch(/^id\s+type\s+created_at$/m);
    // Only observation_recorded rows.
    const dataLines = r.stdout
      .split("\n")
      .filter((l) => /^\s*01[A-Z0-9]+\s+/.test(l));
    expect(dataLines.length).toBe(2);
    for (const line of dataLines) {
      expect(line).toMatch(/observation_recorded/);
    }
    // Other types are excluded.
    expect(r.stdout).not.toMatch(/^01[A-Z0-9]+\s+finding_created/m);
    expect(r.stdout).not.toMatch(/^01[A-Z0-9]+\s+session_created/m);
  });

  it("emits the events.list envelope in --json mode", () => {
    const { sessionId } = setupWithEvents();
    const r = runCli(tmp, ["--json", "events", "--session", sessionId]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as {
      version: number;
      kind: string;
      data: { events: ReadonlyArray<{ id: string; type: string }>; count: number };
    };
    expect(env.version).toBe(1);
    expect(env.kind).toBe("events.list");
    // actor_registered (Cognit-ttc audit side-effect on first
    // ensureActor for "cognit-cli") + session_created + 2
    // observations + 1 finding = 5.
    expect(env.data.count).toBe(5);
    expect(env.data.events).toHaveLength(5);
    const types = env.data.events.map((e) => e.type).sort();
    expect(types).toEqual([
      "actor_registered",
      "finding_created",
      "observation_recorded",
      "observation_recorded",
      "session_created",
    ]);
  });

  it("emits the events.list envelope with --type filter and --json", () => {
    const { sessionId } = setupWithEvents();
    const r = runCli(tmp, [
      "--json",
      "events",
      "--session",
      sessionId,
      "--type",
      "observation_recorded",
    ]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as {
      data: { events: ReadonlyArray<{ type: string }>; count: number };
    };
    expect(env.data.count).toBe(2);
    for (const e of env.data.events) {
      expect(e.type).toBe("observation_recorded");
    }
  });

  it("emits events.follow envelope on --follow and --json (initial flush)", async () => {
    const { sessionId } = setupWithEvents();
    // Run --follow with --json. The initial flush is one batch of N
    // events under kind `events.follow`. We kill the process once the
    // envelope is observed so the test doesn't hang on the polling loop.
    const child: import("node:child_process").ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI_BIN, "--json", "events", "--follow", "--session", sessionId], {
      cwd: tmp,
    }) as import("node:child_process").ChildProcessWithoutNullStreams;
    let stdout = "";
    let killed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (!killed && stdout.includes('"kind": "events.follow"')) {
        // Give the writer a moment to flush before we kill.
        setTimeout(() => {
          if (!killed) {
            killed = true;
            child.kill("SIGTERM");
          }
        }, 100);
      }
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!killed) child.kill("SIGTERM");
        resolve();
      }, 5000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Pull out the FIRST complete JSON envelope (the one that was
    // flushed before kill). Envelopes are single objects printed with
    // 2-space indent and a trailing newline — we find the closing
    // brace of the first top-level object.
    expect(stdout).toContain('"kind": "events.follow"');
    const start = stdout.indexOf("{");
    // Find the matching closing brace at depth 0.
    let depth = 0;
    let end = -1;
    for (let i = start; i < stdout.length; i++) {
      const ch = stdout[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(start);
    const env = JSON.parse(stdout.slice(start, end)) as {
      kind: string;
      data: { count: number; events: ReadonlyArray<{ type: string }> };
    };
    expect(env.kind).toBe("events.follow");
    // Includes actor_registered (Cognit-ttc audit side-effect).
    expect(env.data.count).toBe(5);
    expect(env.data.events).toHaveLength(5);
  });

  it("returns an empty events list (in JSON) for a brand-new session", () => {
    // A brand-new session has only the auto-emitted session_created
    // event — but we still expect the envelope to come back with a
    // count >= 1. We assert the JSON envelope is well-formed and that
    // every event has a `type` field.
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "fresh"]);
    expect(create.status).toBe(0);
    const sessionId = sessionIdOf(create.stdout);
    const r = runCli(tmp, ["--json", "events", "--session", sessionId]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as {
      kind: string;
      data: { count: number; events: ReadonlyArray<{ type: string }> };
    };
    expect(env.kind).toBe("events.list");
    expect(env.data.count).toBeGreaterThanOrEqual(1);
    expect(env.data.events.length).toBe(env.data.count);
    for (const e of env.data.events) {
      expect(typeof e.type).toBe("string");
    }
  });
});
