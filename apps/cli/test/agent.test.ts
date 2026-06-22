/**
 * apps/cli/test/agent.test.ts — `cognit agent (run | status | stop)`.
 *
 * All tests use the mock provider (no API keys). The tests boot a
 * full CLI process via tsx against a tempdir project, so they
 * exercise the wiring end-to-end (commander → layer-build →
 * runTick → state.json).
 *
 * Cases:
 *  1. status on a fresh session → "agent has not run for this session"
 *  2. run --once → 1 tick, exit 0
 *  3. run --once --json → agent.tick + agent.run envelopes parse
 *  4. run --once twice → second invocation's tick_count is 2
 *  5. run exits after stop sentinel (sentinel written ~50ms after start)
 *  6. stop with no agent running → exits 0, no pidfile written
 *  7. stop with stale pidfile → exits 0
 *  8. status after run --once → running: false, tick_count: 1
 *  9. status --json → envelope shape
 * 10. --provider mock --model mock-1 flags override defaults
 * 11. conflict guard: a fake live pid blocks start
 * 12. unknown --provider → commander error before layer build
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(
  cwd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeoutMs ?? 30_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-agent-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

const sessionIdOf = (stdout: string): string => {
  const m = stdout.match(/session:\s+(01[A-Z0-9]+)/i);
  if (!m) throw new Error(`no session id in output: ${stdout}`);
  return m[1]!;
};

const setupProjectAndSession = (): { sessionId: string; cwd: string } => {
  expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
  const create = runCli(tmp, ["session", "create", "agent test"]);
  expect(create.status).toBe(0);
  return { sessionId: sessionIdOf(create.stdout), cwd: tmp };
};

const PIDFILE = (sid: string): string => path.join(tmp, ".cognit", `agent.${sid}.pid`);
const STATEFILE = (sid: string): string =>
  path.join(tmp, ".cognit", `agent.${sid}.state.json`);
const STOPFILE = (sid: string): string => path.join(tmp, ".cognit", `agent.${sid}.stop`);

describe("cognit agent status", () => {
  it("1. prints empty state when no agent has run", () => {
    const { sessionId } = setupProjectAndSession();
    const r = runCli(tmp, ["agent", "status", "--session", sessionId]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("(agent has not run for this session)");
  });

  it("8. shows running=false + tick_count=1 after run --once", () => {
    const { sessionId } = setupProjectAndSession();
    expect(runCli(tmp, ["agent", "run", "--once", "--session", sessionId]).status).toBe(0);
    const r = runCli(tmp, ["agent", "status", "--session", sessionId]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/running:\s+no/);
    expect(r.stdout).toMatch(/tick_count:\s+1/);
  });

  it("9. status --json returns agent.status envelope", () => {
    const { sessionId } = setupProjectAndSession();
    expect(runCli(tmp, ["agent", "run", "--once", "--session", sessionId]).status).toBe(0);
    const r = runCli(tmp, ["--json", "agent", "status", "--session", sessionId]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as {
      version: number;
      kind: string;
      data: {
        sessionId: string;
        running: boolean;
        pid: number | null;
        tick_count: number;
        provider: string | null;
      };
    };
    expect(env.version).toBe(1);
    expect(env.kind).toBe("agent.status");
    expect(env.data.sessionId).toBe(sessionId);
    expect(env.data.running).toBe(false);
    expect(env.data.pid).toBeNull();
    expect(env.data.tick_count).toBe(1);
    expect(env.data.provider).toBe("mock");
  });
});

describe("cognit agent run", () => {
  it("2. run --once exits 0 and writes state.json with tick_count=1", () => {
    const { sessionId } = setupProjectAndSession();
    const r = runCli(tmp, ["agent", "run", "--once", "--session", sessionId]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/tick=\S+ actions=0 overrides=0 truncated=0 stop=false/);
    expect(fs.existsSync(PIDFILE(sessionId))).toBe(false); // cleaned up on exit
    expect(fs.existsSync(STATEFILE(sessionId))).toBe(true);
    const state = JSON.parse(fs.readFileSync(STATEFILE(sessionId), "utf8")) as {
      tick_count: number;
      last_decision_kind: string;
      provider: string;
    };
    expect(state.tick_count).toBe(1);
    expect(state.last_decision_kind).toBe("empty");
    expect(state.provider).toBe("mock");
  });

  it("3. run --once --json emits agent.tick + agent.run envelopes", () => {
    const { sessionId } = setupProjectAndSession();
    const r = runCli(tmp, ["--json", "agent", "run", "--once", "--session", sessionId]);
    expect(r.status).toBe(0);
    // Two JSON envelopes, one per emitted record.
    expect(r.stdout).toContain('"kind": "agent.tick"');
    expect(r.stdout).toContain('"kind": "agent.run"');
    // Parse them as a stream of newline-free JSON objects.
    const envelopes = extractEnvelopes(r.stdout);
    expect(envelopes.length).toBeGreaterThanOrEqual(2);
    const tickEnv = envelopes.find((e) => e.kind === "agent.tick") as unknown as {
      data: { tickId: string; actionsApplied: number; stop: boolean };
    };
    expect(tickEnv.data.tickId).toBeTruthy();
    expect(tickEnv.data.actionsApplied).toBe(0);
    expect(tickEnv.data.stop).toBe(false);
    const runEnv = envelopes.find((e) => e.kind === "agent.run") as unknown as {
      data: { ticksCompleted: number; exitReason: string };
    };
    expect(runEnv.data.ticksCompleted).toBe(1);
    expect(runEnv.data.exitReason).toBe("once");
  });

  it("4. run --once twice → state.tick_count is 2", () => {
    const { sessionId } = setupProjectAndSession();
    expect(runCli(tmp, ["agent", "run", "--once", "--session", sessionId]).status).toBe(0);
    expect(runCli(tmp, ["agent", "run", "--once", "--session", sessionId]).status).toBe(0);
    const state = JSON.parse(fs.readFileSync(STATEFILE(sessionId), "utf8")) as {
      tick_count: number;
    };
    expect(state.tick_count).toBe(2);
  });

  it("5. run (no --once) exits when stop sentinel appears", async () => {
    const { sessionId } = setupProjectAndSession();
    // Spawn the loop without --once in the background, then write
    // the stop sentinel shortly after. Use a 300ms tick interval so
    // we don't burn cycles. Expect exit within 2s.
    const child = spawn(TSX, [
      CLI_ENTRY,
      "agent",
      "run",
      "--session",
      sessionId,
      "--tick-interval-ms",
      "300",
    ], { cwd: tmp }) as import("node:child_process").ChildProcessWithoutNullStreams;
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    // Once we see the first tick line, the loop is alive — drop the sentinel.
    const writeSentinelWhenReady = (): void => {
      if (stdout.includes("tick=")) {
        fs.writeFileSync(STOPFILE(sessionId), new Date().toISOString());
      } else {
        setTimeout(writeSentinelWhenReady, 50);
      }
    };
    setTimeout(writeSentinelWhenReady, 100);
    const exit = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGTERM");
        resolve(-1);
      }, 5000);
      child.on("exit", (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    expect(exit).toBe(0);
    expect(fs.existsSync(STOPFILE(sessionId))).toBe(false); // consumed
    expect(fs.existsSync(PIDFILE(sessionId))).toBe(false); // cleaned up
  });

  it("10. --provider mock --model mock-1 flags work end-to-end", () => {
    const { sessionId } = setupProjectAndSession();
    const r = runCli(tmp, [
      "agent",
      "run",
      "--once",
      "--session",
      sessionId,
      "--provider",
      "mock",
      "--model",
      "mock-1",
    ]);
    expect(r.status).toBe(0);
    const state = JSON.parse(fs.readFileSync(STATEFILE(sessionId), "utf8")) as {
      provider: string;
      model: string;
    };
    expect(state.provider).toBe("mock");
    expect(state.model).toBe("mock-1");
  });

  it("11. conflict guard: refuses to start when another agent is alive", () => {
    const { sessionId } = setupProjectAndSession();
    // Fake a live pid by pointing the pidfile at our own PID and
    // having the test process stay alive (it is — vitest is the
    // parent). probeAgent does `process.kill(pid, 0)` so any live
    // pid works.
    fs.mkdirSync(path.join(tmp, ".cognit"), { recursive: true });
    fs.writeFileSync(PIDFILE(sessionId), String(process.pid));
    const r = runCli(tmp, ["agent", "run", "--once", "--session", sessionId]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/agent already running/);
    fs.unlinkSync(PIDFILE(sessionId));
  });

  it("12. unknown --provider is rejected by schema validation", () => {
    const { sessionId } = setupProjectAndSession();
    const r = runCli(tmp, [
      "agent",
      "run",
      "--once",
      "--session",
      sessionId,
      "--provider",
      "bogus",
    ]);
    expect(r.status).not.toBe(0);
    // Effect Schema prints the bad value verbatim; we check for
    // `actual "bogus"` rather than the generic word "invalid" because
    // the error formatter does not use that word.
    expect(r.stderr).toMatch(/actual "bogus"/);
  });
});

describe("cognit agent stop", () => {
  it("6. stop with no pidfile exits 0 and warns", () => {
    const { sessionId } = setupProjectAndSession();
    const r = runCli(tmp, ["agent", "stop", "--session", sessionId]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/stop signal written/);
    expect(r.stderr).toMatch(/warning/);
  });

  it("7. stop with stale pidfile exits 0", () => {
    const { sessionId } = setupProjectAndSession();
    fs.mkdirSync(path.join(tmp, ".cognit"), { recursive: true });
    // A pid that's almost certainly dead (very large value).
    fs.writeFileSync(PIDFILE(sessionId), "999999");
    const r = runCli(tmp, ["agent", "stop", "--session", sessionId]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/stop signal written/);
  });

  it("emits agent.stop envelope in --json mode", () => {
    const { sessionId } = setupProjectAndSession();
    const r = runCli(tmp, ["--json", "agent", "stop", "--session", sessionId]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as {
      kind: string;
      data: { sessionId: string; requestedAt: string };
    };
    expect(env.kind).toBe("agent.stop");
    expect(env.data.sessionId).toBe(sessionId);
    expect(typeof env.data.requestedAt).toBe("string");
  });
});

/**
 * Helper: extract balanced top-level JSON objects from a stream of
 * pretty-printed envelopes. Mirrors the pattern from events.test.ts.
 */
function extractEnvelopes(stream: string): Array<{
  kind: string;
  data: Record<string, unknown>;
}> {
  const out: Array<{ kind: string; data: Record<string, unknown> }> = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < stream.length; i++) {
    const ch = stream[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const obj = JSON.parse(stream.slice(start, i + 1)) as {
          kind: string;
          data: Record<string, unknown>;
        };
        out.push(obj);
        start = -1;
      }
    }
  }
  return out;
}