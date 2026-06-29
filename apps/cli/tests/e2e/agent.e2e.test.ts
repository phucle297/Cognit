/**
 * apps/cli/test/agent.e2e.test.ts — end-to-end test for the AI
 * supervisor loop and the dashboard AI-reasoning route.
 *
 * Boots a full cognit project in a tempdir, walks the
 * operator workflow:
 *   1. `cognit init`
 *   2. `cognit session create`
 *   3. `cognit hypothesis propose` x3
 *   4. `cognit agent run --once` (mock provider, canned decision)
 *   5. Boot `cognit server` on a free-ish port and wait for /api/healthz
 *   6. Curl /api/sessions/:id/ai-reasoning and /api/sessions/:id/events
 *   7. Tear everything down
 *
 * The mock provider emits an empty decision (no actions, no rank
 * overrides, stop=false) — so we assert:
 *   - agent tick recorded (state.tick_count === 1, last_decision_kind === "empty")
 *   - 0 events appended by the supervisor (mock is empty)
 *   - AI reasoning route returns 200 with a valid envelope shape
 *     (ranked: [], decision_log: [{...0 actions, 0 overrides, stop=false}])
 *
 * C5 acceptance: verifies the wiring from CLI → supervisor → event
 * store → HTTP server → dashboard query. Real LLM tests live in
 * `@cognit/llm`; this test owns the integration glue.
 *
 * ---
 * INTEGRATION-ONLY — opt in with `RUN_AGENT_E2E=1 pnpm test`.
 *
 * Each test boots a real `cognit server` child process through
 * `tsx` and polls /api/healthz. The cold-start cost (commander 15,
 * better-sqlite3 12, drizzle 0.45, effect 3.21) plus the server
 * bind + event-store warm-up easily pushes past vitest's 30s
 * default when CPU is contended across the parallel test run.
 * That makes these tests flaky in CI even though the code under
 * test is deterministic — the timing budget, not the logic, is
 * the variable.
 *
 * Default `pnpm test` skips these. Set `RUN_AGENT_E2E=1` to run
 * them as part of a release gate / nightly job.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

// `cognit server` (via dist) spawns the peer `apps/server` package
// through tsx, using a path resolved from the server.ts source
// location. After tsup bundles server.ts into dist/index.js the
// resolution depth shifts and the spawn target moves out of the
// repo. For the agent e2e we boot the server through tsx + the
// source entry directly so the resolved tsx path matches the
// source layout — preserving the original behaviour.
const TSX = path.resolve(__dirname, "..", "..", "node_modules", ".bin", "tsx");
const CLI_ENTRY = path.resolve(__dirname, "..", "..", "src", "index.ts");

// Server boot in this E2E goes through a fresh `tsx` child + a full
// app-layer build (DB migrations, drizzle, commander 15, effect 3.21).
// 5s was too tight when vitest runs 20+ test files in parallel and
// CPU contention pushes cold-start past 25s on a 4-core runner.
const HEALTHZ_TIMEOUT_MS = 30_000;
const sessionIdOf = (stdout: string): string => {
  const m = stdout.match(/session:\s+(01[A-Z0-9]+)/i);
  if (!m) throw new Error(`no session id in output: ${stdout}`);
  return m[1]!;
};

const hypothesisIdOf = (stdout: string): string => {
  const m = stdout.match(/event:\s+(01[A-Z0-9]+)/i);
  if (!m) throw new Error(`no hypothesis event id in output: ${stdout}`);
  return m[1]!;
};

const pickPort = (): number => {
  // 16k + pid-mod so concurrent test workers don't collide. The
  // server rejects double-bind on EADDRINUSE; the assertion is
  // "test isolates itself well enough", not "guaranteed unique".
  return 16_000 + ((process.pid % 10_000) | 0);
};

const waitForHealthz = (base: string, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`${base}/api/healthz`);
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        /* server not ready yet */
      }
      if (Date.now() >= deadline) {
        reject(new Error(`healthz did not respond within ${timeoutMs}ms at ${base}`));
        return;
      }
      setTimeout(() => {
        void tick();
      }, 100);
    };
    void tick();
  });

interface RunningServer {
  readonly base: string;
  readonly close: () => Promise<void>;
}

const startServer = (cwd: string, port: number): RunningServer => {
  const child: ChildProcessWithoutNullStreams = spawn(
    TSX,
    [CLI_ENTRY, "server", "--host", "127.0.0.1", "--port", String(port), "--root", cwd],
    { cwd, env: process.env },
  );
  let stderrBuf = "";
  child.stderr.on("data", (c: Buffer) => {
    stderrBuf += c.toString("utf8");
  });
  const close = async (): Promise<void> => {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    // Surface stderr if the server died unexpectedly — vitest prints
    // this on assertion failure, saving a debug round-trip.
    if (child.exitCode !== null && child.exitCode !== 0 && process.env.DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`server exited ${child.exitCode}; stderr:\n${stderrBuf}`);
    }
  };
  return { base: `http://127.0.0.1:${port}`, close };
};

let tmp: string;
let port: number;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cognit-agent-e2e-"));
  port = pickPort();
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const STATEFILE = (sid: string): string =>
  path.join(tmp, ".cognit", `agent.${sid}.state.json`);

describe("cognit agent — end-to-end (CLI → supervisor → HTTP route)", () => {
  // Default-skip: see file header. Run with RUN_AGENT_E2E=1.
  it.runIf(Boolean(process.env.RUN_AGENT_E2E))(
    "1. init → session → 3 hypotheses → agent run --once → wire shape on /ai-reasoning",
    async () => {
    expect(runCli(tmp, ["init", "--project", "e2e"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "supervisor e2e"]);
    expect(create.status).toBe(0);
    const sessionId = sessionIdOf(create.stdout);

    for (const title of ["alpha", "beta", "gamma"]) {
      const h = runCli(tmp, [
        "hypothesis",
        "propose",
        title,
        "--text",
        `text for ${title}`,
        "--session",
        sessionId,
      ]);
      expect(h.status).toBe(0);
      hypothesisIdOf(h.stdout); // sanity: each propose yields an id
    }

    // Run the supervisor once. The mock provider's canned decision
    // is empty (no actions, no rank overrides, stop=false) — so we
    // assert state, NOT events on the supervisor's behalf.
    const run = runCli(tmp, [
      "agent",
      "run",
      "--once",
      "--session",
      sessionId,
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(
      /tick=\S+ actions=0 overrides=0 truncated=0 stop=false/,
    );

    // State file is written by the run loop after the tick.
    const stateRaw = await fsp.readFile(STATEFILE(sessionId), "utf8");
    const state = JSON.parse(stateRaw) as {
      tick_count: number;
      last_decision_kind: string;
      provider: string;
      model: string;
    };
    expect(state.tick_count).toBe(1);
    expect(state.last_decision_kind).toBe("empty");
    expect(state.provider).toBe("mock");
    expect(state.model).toBe("mock-1");

    // Boot the server, hit the C4 wire shape, tear down.
    const server = startServer(tmp, port);
    try {
      await waitForHealthz(server.base, HEALTHZ_TIMEOUT_MS);
      const aiRes = await fetch(
        `${server.base}/api/sessions/${sessionId}/ai-reasoning`,
      );
      expect(aiRes.status).toBe(200);
      const aiBody = (await aiRes.json()) as {
        version: number;
        kind: string;
        data: {
          session_id: string;
          ranked: ReadonlyArray<unknown>;
          decision_log: ReadonlyArray<{
            tick_event_id: string;
            actions_applied: number;
            rank_overrides_applied: number;
            actions_truncated: number;
            stop: boolean;
            created_at: string;
          }>;
        };
      };
      expect(aiBody.version).toBe(1);
      expect(aiBody.kind).toBe("session.ai_reasoning");
      expect(aiBody.data.session_id).toBe(sessionId);
      // Mock emits no rank overrides → every hypothesis is rule-
      // scored. The route still surfaces them (source="rule",
      // ai_score=null) so the dashboard can show what the AI did
      // NOT touch. The 3 we proposed must all be present.
      expect(aiBody.data.ranked).toHaveLength(3);
      const ranked = aiBody.data.ranked as ReadonlyArray<{
        source: string;
        ai_score: number | null;
        ai_rank_event_id: string | null;
      }>;
      for (const r of ranked) {
        expect(r.source).toBe("rule");
        expect(r.ai_score).toBeNull();
        expect(r.ai_rank_event_id).toBeNull();
      }
      // The decision_log buckets every event for the session by
      // tick prefix; bootstrap events (session_created, 3x
      // hypothesis_created) without an agent `-a`/`-r` suffix
      // each become their own bucket. The supervisor emitted zero
      // events (mock decision is empty), so every bucket has
      // actions=0, overrides=0. We assert shape, not count —
      // future event-id formats or actor_registered audit rows
      // could shift the count, but the mock-empty invariant
      // must hold.
      expect(aiBody.data.decision_log.length).toBeGreaterThan(0);
      const decisionLog = aiBody.data.decision_log as ReadonlyArray<{
        tick_event_id: string;
        actions_applied: number;
        rank_overrides_applied: number;
        actions_truncated: number;
        stop: boolean;
      }>;
      for (const tick of decisionLog) {
        expect(tick.actions_applied).toBe(0);
        expect(tick.rank_overrides_applied).toBe(0);
        expect(tick.actions_truncated).toBe(0);
        expect(tick.stop).toBe(false);
        expect(typeof tick.tick_event_id).toBe("string");
        expect(tick.tick_event_id.length).toBeGreaterThan(0);
      }
    } finally {
      await server.close();
    }
  }, 120_000);

  it.runIf(Boolean(process.env.RUN_AGENT_E2E))(
    "2. the /ai-reasoning route returns 404 for an unknown session",
    async () => {
    expect(runCli(tmp, ["init", "--project", "e2e-404"]).status).toBe(0);
    const server = startServer(tmp, port);
    try {
      await waitForHealthz(server.base, HEALTHZ_TIMEOUT_MS);
      const r = await fetch(
        `${server.base}/api/sessions/01ZZZZZZZZZZZZZZZZZZZZZZZZ/ai-reasoning`,
      );
      // 404 (not_found envelope) — the dashboard's error path.
      expect(r.status).toBe(404);
      const body = (await r.json()) as { kind: string; code: string };
      expect(body.kind).toBe("api_error");
      expect(body.code).toBe("not_found");
    } finally {
      await server.close();
    }
  }, 120_000);

  it.runIf(Boolean(process.env.RUN_AGENT_E2E))(
    "3. the /ai-reasoning SSE stream returns a 200 with text/event-stream content-type",
    async () => {
    expect(runCli(tmp, ["init", "--project", "e2e-sse"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "sse e2e"]);
    const sessionId = sessionIdOf(create.stdout);
    const server = startServer(tmp, port);
    try {
      await waitForHealthz(server.base, HEALTHZ_TIMEOUT_MS);
      const ctl = new AbortController();
      // The `fetch` call below respects the AbortSignal; once we
      // get the response headers back, we cancel so the body
      // stream closes and the server's writer unblocks.
      const r = await fetch(
        `${server.base}/api/sessions/${sessionId}/ai-reasoning/stream`,
        { signal: ctl.signal },
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/text\/event-stream/);
      // Detach: abort the controller (already aborted by us
      // tearing down the test) and drain to avoid hanging the
      // test process on a live stream.
      try {
        ctl.abort();
      } catch {
        /* fetch may have already settled */
      }
      try {
        await r.body?.cancel();
      } catch {
        /* body may already be closed */
      }
    } finally {
      await server.close();
    }
  }, 120_000);
});
