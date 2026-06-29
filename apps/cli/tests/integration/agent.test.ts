/**
 * apps/cli/test/agent.test.ts — `cognit agent (run | status | stop)`.
 *
 * All tests use the canned `mock-1` model (no API keys). The tests
 * boot a full CLI process via tsx against a tempdir project, so they
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
 * 11. conflict guard: a fake live pid blocks start
 * 13. concurrent run: second process fails with conflict (pidfile race closed)
 * 14. second SIGTERM exits 143 (not 130)
 * 15. probeLiveness treats EPERM as alive (refuses to clobber foreign pid)
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli, CLI_BIN } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
    const child = spawn(process.execPath, [
      CLI_BIN,
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

  it("10. --model mock-1 flag triggers the canned layer end-to-end", () => {
    const { sessionId } = setupProjectAndSession();
    const r = runCli(tmp, [
      "agent",
      "run",
      "--once",
      "--session",
      sessionId,
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

  it("13. concurrent run: second process fails with conflict (pidfile race closed)", { timeout: 30_000 }, async () => {
    const { sessionId } = setupProjectAndSession();
    // Spawn a long-lived agent loop in the background — no --once,
    // long tick interval so it stays alive for the duration of the
    // second invocation.
    const first = spawn(process.execPath, [
      CLI_BIN,
      "agent",
      "run",
      "--session",
      sessionId,
      "--tick-interval-ms",
      "2000",
    ], { cwd: tmp }) as import("node:child_process").ChildProcessWithoutNullStreams;
    // Wait for the first process to claim its pidfile before
    // spawning the second. The first line of text output appears
    // only after the first tick finishes, so poll for the pidfile
    // directly (cheaper, race-free).
    const pidfile = PIDFILE(sessionId);
    const startDeadline = Date.now() + 5000;
    while (Date.now() < startDeadline && !fs.existsSync(pidfile)) {
      await sleep(20);
    }
    expect(fs.existsSync(pidfile)).toBe(true);

    // Second process should lose the race and exit non-zero with the
    // conflict error.
    const second = runCli(tmp, [
      "agent",
      "run",
      "--once",
      "--session",
      sessionId,
    ]);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/agent already running/);

    // Clean up: stop the first loop and wait for it to exit so the
    // pidfile disappears.
    first.kill("SIGTERM");
    await new Promise<void>((resolve) => first.on("exit", () => resolve()));
  });

  it("14. second SIGTERM exits 143 (not 130)", async () => {
    const { sessionId } = setupProjectAndSession();
    // Start the loop in the background, send SIGTERM twice, verify
    // the second-signal exit code follows POSIX (143 for SIGTERM).
    const child = spawn(process.execPath, [
      CLI_BIN,
      "agent",
      "run",
      "--session",
      sessionId,
      "--tick-interval-ms",
      "2000",
    ], { cwd: tmp }) as import("node:child_process").ChildProcessWithoutNullStreams;
    const pidfile = PIDFILE(sessionId);
    const startDeadline = Date.now() + 5000;
    while (Date.now() < startDeadline && !fs.existsSync(pidfile)) {
      await sleep(20);
    }
    expect(fs.existsSync(pidfile)).toBe(true);
    // First signal: graceful drain.
    child.kill("SIGTERM");
    // Second signal before the graceful drain finishes: hard exit
    // with the signal-specific code. Send quickly so we hit the
    // second-signal branch.
    await sleep(20);
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(-1);
      }, 5000);
      child.on("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    expect(code).toBe(143);
  });

  it("15. probeLiveness treats EPERM as alive (refuses to clobber foreign pid)", async () => {
    // A pid owned by another user (EPERM) must be reported alive so
    // the CLI refuses to clobber it. We simulate the syscall by
    // monkey-patching `process.kill` for the duration of the probe.
    // `probeLiveness` reads `process.kill` at call time, so the
    // monkey-patch is observed.
    const { probeLiveness } = await import("../../src/agent-state.js");
    const real = process.kill.bind(process);
    const fake = ((pid: number, sig: number | NodeJS.Signals): boolean => {
      if (sig === 0) {
        const e = new Error("EPERM") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      return real(pid, sig);
    }) as typeof process.kill;
    process.kill = fake;
    try {
      expect(probeLiveness(1)).toBe(true);
    } finally {
      process.kill = real;
    }
    // And the negative case: ESRCH should still be dead.
    const fakeDead = ((pid: number, sig: number | NodeJS.Signals): boolean => {
      if (sig === 0) {
        const e = new Error("ESRCH") as NodeJS.ErrnoException;
        e.code = "ESRCH";
        throw e;
      }
      return real(pid, sig);
    }) as typeof process.kill;
    process.kill = fakeDead;
    try {
      expect(probeLiveness(1)).toBe(false);
    } finally {
      process.kill = real;
    }
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
      data: {
        sessionId: string;
        requestedAt: string;
        warning: string | null;
      };
    };
    expect(env.kind).toBe("agent.stop");
    expect(env.data.sessionId).toBe(sessionId);
    expect(typeof env.data.requestedAt).toBe("string");
    // No prior pidfile → warning should be surfaced in the JSON
    // envelope (not just stderr) so automation can detect it.
    expect(env.data.warning).toMatch(/no agent pidfile/);
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

// ---------------------------------------------------------------------------
// Proxy routing (Cognit-to3, spec §4)
//
// Unit tests for `resolveAgentRun` — pure helper that turns CLI flags +
// `cognit.yaml` into a runnable `AgentConfig` + (state.provider, state.model)
// tuple. End-to-end proxy calls require a real LiteLLM proxy + env key;
// we exercise the routing here and leave the network round-trip to
// manual smoke runs.
// ---------------------------------------------------------------------------

import { resolveAgentRun } from "../../src/commands/agent.js";
import { parseCognitConfig } from "@cognit/core/config";

describe("resolveAgentRun — proxy routing (spec §4)", () => {
  const cfgNoLlm = parseCognitConfig({ project: { name: "x" } });
  const cfgDefaultModel = parseCognitConfig({
    project: { name: "x" },
    llm: { default_model: "anthropic/claude-sonnet-4-6" },
  });
  const cfgCommandModel = parseCognitConfig({
    project: { name: "x" },
    llm: {
      commands: { agent_run: { model: "openai/gpt-4o" } },
    },
  });

  it("--model alone (proxy route) — model preserved, canned when mock-1", () => {
    const r = resolveAgentRun(cfgNoLlm, { model: "anthropic/claude-sonnet-4-6" });
    expect(r.agentCfg.model).toBe("anthropic/claude-sonnet-4-6");
    expect(r.stateProvider).toBe("proxy");
    expect(r.stateModel).toBe("anthropic/claude-sonnet-4-6");
  });

  it("--model mock-1 routes to the canned layer (state.provider = 'mock')", () => {
    const r = resolveAgentRun(cfgNoLlm, { model: "mock-1" });
    expect(r.agentCfg.model).toBe("mock-1");
    expect(r.stateProvider).toBe("mock");
    expect(r.stateModel).toBe("mock-1");
  });

  it("no flags + llm.default_model — proxy route from config", () => {
    const r = resolveAgentRun(cfgDefaultModel, {});
    expect(r.agentCfg.model).toBe("anthropic/claude-sonnet-4-6");
    expect(r.stateProvider).toBe("proxy");
    expect(r.stateModel).toBe("anthropic/claude-sonnet-4-6");
  });

  it("no flags + llm.commands.agent_run.model — command-scoped config wins over default_model", () => {
    const cfgBoth = parseCognitConfig({
      project: { name: "x" },
      llm: {
        default_model: "anthropic/claude-sonnet-4-6",
        commands: { agent_run: { model: "openai/gpt-4o" } },
      },
    });
    const r = resolveAgentRun(cfgBoth, {});
    expect(r.agentCfg.model).toBe("openai/gpt-4o");
    expect(r.stateModel).toBe("openai/gpt-4o");
  });

  it("no flags + no llm config — mock canned fallback (smoke runs)", () => {
    const r = resolveAgentRun(cfgNoLlm, {});
    expect(r.agentCfg.model).toBe("mock-1");
    expect(r.stateProvider).toBe("mock");
    expect(r.stateModel).toBe("mock-1");
  });

  it("--model alone takes precedence over llm.commands.agent_run.model", () => {
    const r = resolveAgentRun(cfgCommandModel, { model: "anthropic/claude-sonnet-4-6" });
    expect(r.agentCfg.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("config-resolved mock-1 routes to the canned layer (state.provider = 'mock')", () => {
    const cfgMock = parseCognitConfig({
      project: { name: "x" },
      llm: { default_model: "mock-1" },
    });
    const r = resolveAgentRun(cfgMock, {});
    expect(r.agentCfg.model).toBe("mock-1");
    expect(r.stateProvider).toBe("mock");
  });
});