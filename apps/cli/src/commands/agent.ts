/**
 * apps/cli/src/commands/agent.ts — `cognit agent (run | status | stop)`.
 *
 * Phase C3: CLI surface for the supervisor loop in `@cognit/agent`.
 * Wires the loop into the operator's terminal with three subcommands:
 *
 *   - `run`    — drives `runTick` (foreground; loops by default,
 *                `--once` for a single tick). Writes a pidfile +
 *                per-tick state JSON under `.cognit/`. Handles
 *                SIGINT/SIGTERM gracefully — finishes the in-flight
 *                tick, then exits with the conventional code
 *                (130 / 143).
 *   - `status` — reads the pidfile + state JSON and reports whether
 *                the agent is currently running for the session,
 *                plus tick count and last tick id.
 *   - `stop`   — touches the stop sentinel. The running `run` loop
 *                observes it between ticks and exits cleanly.
 *
 * State artefacts (under `.cognit/`):
 *   - `agent.<sid>.pid`        — written by `run` at start
 *   - `agent.<sid>.stop`       — written by `stop`
 *   - `agent.<sid>.state.json` — written by `run` after each tick
 *
 * Output:
 *   - default (text): key/value lines, one per tick in `run` mode.
 *   - `--json`: stable v1 envelopes (`agent.tick`, `agent.run`,
 *     `agent.status`, `agent.stop`).
 *
 * Gateway migration (Cognit-l06/007):
 *   The supervisor loop routes every real-LLM call through the
 *   Vercel AI Gateway. `--model` is the canonical flag and is
 *   resolved by `resolveModel(config, "agent_run", opts.model)`
 *   (flag > llm.commands.agent_run.model > llm.default_model).
 *   The model id format is `<provider>/<id>` (e.g.
 *   `anthropic/claude-sonnet-4-6`). The canned layer is reached
 *   when the resolved model id is `mock-1` (the default).
 */
import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { defaultConfig, type CognitConfig } from "@cognit/core/config";
import {
  runTick,
  type AgentConfig,
  defaultAgentConfig,
  parseAgentConfig,
} from "@cognit/agent";
import { withAppLayerAndConfigAndAgent } from "../layer-build.js";
import { resolveModel } from "../config-resolver.js";
import {
  consumeStop,
  clearPidfile,
  claimPidfile,
  probeAgent,
  readAgentState,
  requestStop,
  writeAgentState,
} from "../agent-state.js";
import { findProjectRoot, projectPaths } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { emit, getOutputMode } from "../output.js";
import { readConfig } from "../yaml-io.js";

interface RunOptions {
  session?: string;
  model?: string;
  once?: boolean;
  maxTicks?: string;
  tickIntervalMs?: string;
}

interface StatusOptions {
  session?: string;
}

interface StopOptions {
  session?: string;
}

const ACTOR = { name: "cognit-cli", type: "system" as const };

const requireProjectRoot = (): string => {
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write(
      "cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n",
    );
    process.exitCode = 2;
    throw new Error("not in a cognit project");
  }
  return root;
};

const resolveRequiredSession = (
  root: string,
  explicit: string | undefined,
): string | null => {
  const resolved = resolveSessionId(root, explicit);
  if (!resolved) {
    process.stderr.write(
      "cognit: --session is required (or run `cognit session create` to set the sticky pointer)\n",
    );
    process.exitCode = 2;
    return null;
  }
  if (resolved.source === "pointer") warnStalePointer(root, resolved.sessionId);
  return resolved.sessionId;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Map a supervisor-tick `decision` into the summary string used in
 * the `last_decision_kind` field of `state.json`.
 */
const summarizeDecision = (d: {
  readonly stop: boolean;
  readonly actions: ReadonlyArray<unknown>;
  readonly rank_overrides: ReadonlyArray<unknown>;
}): "stop" | "actions" | "rank_overrides" | "empty" => {
  if (d.stop) return "stop";
  if (d.actions.length > 0) return "actions";
  if (d.rank_overrides.length > 0) return "rank_overrides";
  return "empty";
};

/** Per-tick terminal output (text mode). */
const printTickText = (r: {
  readonly tickId: string;
  readonly actionsApplied: number;
  readonly rankOverridesApplied: number;
  readonly actionsTruncated: number;
  readonly stop: boolean;
}): void => {
  process.stdout.write(
    `tick=${r.tickId} actions=${r.actionsApplied} ` +
      `overrides=${r.rankOverridesApplied} ` +
      `truncated=${r.actionsTruncated} stop=${r.stop}\n`,
  );
};

/**
 * Per-tick error reporting. Typed errors map to clean stderr lines;
 * unknown failures fall back to the message. Exit code is set on
 * the first failure so the operator's `$?` is honest.
 */
const printTickError = (e: unknown): void => {
  const err = e as {
    name?: string;
    message?: string;
    raw?: string;
  };
  const tag = err.name ?? "Error";
  const raw = err.raw ? ` (raw: ${JSON.stringify(err.raw).slice(0, 200)})` : "";
  process.stderr.write(`cognit: tick failed: ${tag}: ${err.message ?? String(e)}${raw}\n`);
  if (process.exitCode === undefined) process.exitCode = 1;
};

/**
 * Outcome of resolving CLI flags + config into a runnable
 * `AgentConfig`. Exposed for tests that want to assert the routing
 * logic without booting the supervisor loop.
 *
 * - `agentCfg` — the `AgentConfig` handed to `runTick` + the layer
 *   builder. `model === "mock-1"` → canned layer; any other model
 *   id → Vercel AI Gateway route.
 * - `stateProvider` / `stateModel` — the values written into
 *   `agent.<sid>.state.json`. `stateProvider` is `"mock"` when the
 *   canned layer is used, otherwise `"gateway"`. `stateModel` is
 *   the resolved model id.
 */
export interface ResolvedAgentRun {
  readonly agentCfg: AgentConfig;
  readonly stateProvider: string;
  readonly stateModel: string;
}

/**
 * Resolve the `AgentConfig` + state-recording fields from CLI flags
 * + `cognit.yaml`. Pure function — no I/O, no side effects. Order
 * (spec §4):
 *
 *   1. `--model <m>` → Gateway route when `<m>` is anything other
 *      than `mock-1`. Canned layer when `<m>` is `mock-1`.
 *   2. No flag → `resolveModel(config, "agent_run")` for the
 *      Gateway id. Falls back to `defaultAgentConfig` (mock canned)
 *      when no model is configured anywhere — preserves the
 *      pre-migration behaviour for `cognit init`-only smoke runs.
 *
 * Exported for tests that want to assert the routing without
 * booting the supervisor loop.
 */
export const resolveAgentRun = (
  config: CognitConfig,
  opts: RunOptions,
): ResolvedAgentRun => {
  // 1. --model <m>: Gateway route unless it's the canned marker.
  if (opts.model !== undefined && opts.model.length > 0) {
    const canned = opts.model === "mock-1";
    return {
      agentCfg: parseAgentConfig({ model: opts.model }),
      stateProvider: canned ? "mock" : "gateway",
      stateModel: opts.model,
    };
  }

  // 2. No flag: try config resolution. Fall back to the mock
  // canned layer when nothing is configured so `cognit init` +
  // `cognit agent run --once` continues to work without an llm:
  // block (the pre-migration default).
  try {
    const resolved = resolveModel(config, "agent_run");
    const canned = resolved === "mock-1";
    return {
      agentCfg: parseAgentConfig({ model: resolved }),
      stateProvider: canned ? "mock" : "gateway",
      stateModel: resolved,
    };
  } catch {
    return {
      agentCfg: defaultAgentConfig,
      stateProvider: "mock",
      stateModel: defaultAgentConfig.model,
    };
  }
};

/**
 * `cognit agent run --session <id> [--model <provider/id>]
 *                        [--once] [--max-ticks N] [--tick-interval-ms N]`
 *
 * Drives the supervisor loop. See file-level docstring for the full
 * state-machine. Exit codes: 0 normal, 1 runtime error, 130 SIGINT,
 * 143 SIGTERM, 2 CLI argument error.
 */
const runCommand = async (opts: RunOptions): Promise<void> => {
  const root = requireProjectRoot();
  const sessionId = resolveRequiredSession(root, opts.session);
  if (!sessionId) return;

  // Read cognit.yaml so `resolveModel(config, "agent_run", …)` can
  // honour `llm.commands.agent_run.model` and `llm.default_model`.
  // Schema failures here exit 2 — the file is malformed; we surface
  // the error early rather than half-building the layer.
  let config: CognitConfig;
  try {
    config = await readConfig(projectPaths(root).config);
  } catch (e) {
    const tag = e instanceof Error ? e.name : "Error";
    process.stderr.write(
      `cognit: failed to read config: ${tag}: ${(e as Error).message ?? String(e)}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const resolved = resolveAgentRun(config, opts);
  const agentCfg = resolved.agentCfg;
  // Capture the recorded (provider, model) pair ONCE so every tick
  // writes the same shape into state.json.
  const stateProvider = resolved.stateProvider;
  const stateModel = resolved.stateModel;

  // Conflict guard. Two `cognit agent run` processes for the same
  // session at the same time is a user error (and a corruption risk
  // for state.json). We claim the pidfile slot first with
  // `O_CREAT|O_EXCL` (atomic) — if the claim fails, we lost the race
  // and re-probe to report the winning pid. This closes the
  // pre-fix TOCTOU window where two processes could both pass
  // `probeAgent`'s liveness check (no pidfile) and both proceed.
  const claimed = await claimPidfile(root, sessionId);
  if (!claimed) {
    // Race-loser. The other process is mid-claim or already owns
    // the slot — re-probe to give the operator the live pid in the
    // error message.
    const existing = await probeAgent(root, sessionId);
    const detail =
      existing.pid !== null
        ? `pid ${existing.pid}${existing.running ? "" : " (stale pidfile)"}`
        : "another agent is starting up";
    process.stderr.write(
      `cognit: agent already running for session ${sessionId} (${detail})\n`,
    );
    process.exitCode = 1;
    return;
  }

  const maxTicks = opts.maxTicks !== undefined ? Number.parseInt(opts.maxTicks, 10) : 0;
  const tickIntervalMs =
    opts.tickIntervalMs !== undefined
      ? Number.parseInt(opts.tickIntervalMs, 10)
      : 5000;

  // Initialize state file on first start. Subsequent ticks update it.
  let state = await readAgentState(root, sessionId);
  const startedAt = new Date().toISOString();
  if (state === null) {
    state = {
      last_tick_id: null,
      tick_count: 0,
      last_decision_kind: "empty",
      provider: stateProvider,
      model: stateModel,
      started_at: startedAt,
      updated_at: startedAt,
    };
  }

  // SIGINT/SIGTERM flip a flag the loop checks between ticks. We
  // let the in-flight tick finish (Effect.runPromise is not
  // cancelable from outside without restructuring) so the event
  // store stays consistent.
  let stoppedBySignal: NodeJS.Signals | null = null;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (stoppedBySignal !== null) {
      // Second signal — abort hard. Don't await the loop body.
      // POSIX exit codes: 130 = SIGINT, 143 = SIGTERM.
      process.stderr.write(`cognit: received ${sig} twice, exiting\n`);
      process.exit(sig === "SIGINT" ? 130 : 143);
    }
    stoppedBySignal = sig;
    process.stderr.write(`cognit: received ${sig}, finishing current tick and exiting\n`);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const clearOnExit = async (): Promise<void> => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await clearPidfile(root, sessionId);
  };

  const json = getOutputMode() === "json";
  const cfg = defaultConfig("(unknown)"); // cfg is read for compat with loop's first arg
  let exitReason: "stop_decision" | "stop_signal" | "max_ticks" | "once" | "error" =
    opts.once === true ? "once" : "max_ticks";
  let exitCode = 0;

  try {
    let ticksCompleted = 0;
    let lastTickId: string | null = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (stoppedBySignal !== null) {
        exitReason = "stop_signal";
        break;
      }
      if (await consumeStop(root, sessionId)) {
        exitReason = "stop_decision";
        break;
      }
      if (maxTicks > 0 && ticksCompleted >= maxTicks) {
        exitReason = "max_ticks";
        break;
      }

      const tickId = `${Date.now().toString(36)}-${ticksCompleted}`;
      const program = Effect.gen(function* () {
        return yield* runTick({
          sessionId,
          cfg,
          agent: agentCfg,
          actor: ACTOR,
          tickId,
        });
      });
      let provided;
      try {
        provided = await withAppLayerAndConfigAndAgent(root, program, agentCfg);
      } catch (e) {
        // Layer build (e.g. missing env var) failed. Surface and exit.
        printTickError(e);
        exitReason = "error";
        exitCode = 1;
        break;
      }
      const exit = await Effect.runPromiseExit(provided);
      if (Exit.isFailure(exit)) {
        const cause = exit.cause;
        const fail = Cause.failureOption(cause);
        if (fail._tag === "Some") {
          printTickError(fail.value);
        } else {
          const die = Cause.dieOption(cause);
          printTickError(die._tag === "Some" ? die.value : new Error("tick: unknown failure"));
        }
        exitReason = "error";
        exitCode = 1;
        break;
      }
      const result = exit.value;
      ticksCompleted += 1;
      lastTickId = result.tickId;
      const updatedAt = new Date().toISOString();
      state = {
        last_tick_id: result.tickId,
        tick_count: state.tick_count + 1,
        last_decision_kind: summarizeDecision(result.decision),
        provider: stateProvider,
        model: stateModel,
        started_at: state.started_at,
        updated_at: updatedAt,
      };
      await writeAgentState(root, sessionId, state);
      if (json) {
        emit("json", "agent.tick", {
          tickId: result.tickId,
          actionsApplied: result.actionsApplied,
          rankOverridesApplied: result.rankOverridesApplied,
          actionsTruncated: result.actionsTruncated,
          stop: result.stop,
        });
      } else {
        printTickText(result);
      }
      if (result.stop) {
        exitReason = "stop_decision";
        break;
      }
      if (opts.once === true) {
        exitReason = "once";
        break;
      }
      // Sleep, but stay responsive to signals + sentinel. We poll in
      // 250ms slices — granular enough for SIGINT to feel instant,
      // cheap enough to not waste CPU.
      const sleepDeadline = Date.now() + tickIntervalMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (stoppedBySignal !== null) {
          exitReason = "stop_signal";
          break;
        }
        if (await consumeStop(root, sessionId)) {
          exitReason = "stop_decision";
          break;
        }
        if (Date.now() >= sleepDeadline) break;
        await sleep(Math.min(250, Math.max(0, sleepDeadline - Date.now())));
      }
      // If the inner sleep loop set a more-specific reason (signal or
      // sentinel), break out of the tick loop now. Otherwise we're
      // just past the sleep interval — continue.
      if (exitReason === "stop_signal" || exitReason === "stop_decision") {
        break;
      }
    }

    if (json) {
      emit("json", "agent.run", {
        ticksCompleted,
        lastTickId,
        exitReason,
        sessionId,
      });
    } else {
      process.stdout.write(
        `agent: ${exitReason} after ${ticksCompleted} tick(s) (last=${lastTickId ?? "—"})\n`,
      );
    }
  } finally {
    await clearOnExit();
  }

  // Set exit code AFTER cleanup so the operator's `$?` reflects the
  // real reason, not the cleanup teardown.
  if (exitReason === "stop_signal" && stoppedBySignal !== null) {
    process.exit(stoppedBySignal === "SIGINT" ? 130 : 143);
  }
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
};

/**
 * `cognit agent status --session <id> [--json]`
 *
 * Reports whether an agent is currently running for the session plus
 * the persisted tick count and last tick id. Reads state.json +
 * pidfile from `.cognit/`; does not touch the event store.
 */
const statusCommand = async (opts: StatusOptions): Promise<void> => {
  const root = requireProjectRoot();
  const sessionId = resolveRequiredSession(root, opts.session);
  if (!sessionId) return;

  const live = await probeAgent(root, sessionId);
  const state = await readAgentState(root, sessionId);
  const json = getOutputMode() === "json";

  const data = {
    sessionId,
    running: live.running,
    pid: live.pid,
    provider: state?.provider ?? null,
    model: state?.model ?? null,
    tick_count: state?.tick_count ?? 0,
    last_tick_id: state?.last_tick_id ?? null,
    last_decision_kind: state?.last_decision_kind ?? null,
    started_at: state?.started_at ?? null,
    updated_at: state?.updated_at ?? null,
  };

  if (json) {
    emit("json", "agent.status", data);
    return;
  }
  if (state === null && live.pid === null) {
    process.stdout.write("(agent has not run for this session)\n");
    return;
  }
  process.stdout.write(`session:      ${sessionId}\n`);
  process.stdout.write(
    `running:      ${live.running ? `yes (pid ${live.pid})` : "no"}\n`,
  );
  if (state !== null) {
    process.stdout.write(`provider:     ${state.provider}\n`);
    process.stdout.write(`model:        ${state.model}\n`);
    process.stdout.write(`tick_count:   ${state.tick_count}\n`);
    process.stdout.write(
      `last_tick_id: ${state.last_tick_id ?? "—"}\n`,
    );
    process.stdout.write(`started_at:   ${state.started_at}\n`);
    process.stdout.write(`updated_at:   ${state.updated_at}\n`);
  }
};

/**
 * `cognit agent stop --session <id> [--json]`
 *
 * Idempotent. Always succeeds. Writes the stop sentinel under
 * `.cognit/`; the running `run` loop observes it between ticks and
 * exits cleanly. A second invocation is a no-op.
 */
const stopCommand = async (opts: StopOptions): Promise<void> => {
  const root = requireProjectRoot();
  const sessionId = resolveRequiredSession(root, opts.session);
  if (!sessionId) return;

  const live = await probeAgent(root, sessionId);
  await requestStop(root, sessionId);
  const requestedAt = new Date().toISOString();
  const warning =
    live.pid === null
      ? `no agent pidfile for session ${sessionId}; stop sentinel written anyway`
      : null;
  if (getOutputMode() === "json") {
    emit("json", "agent.stop", {
      sessionId,
      requestedAt,
      wasRunning: live.running,
      pid: live.pid,
      warning,
    });
    return;
  }
  if (warning !== null) {
    process.stderr.write(`cognit: warning — ${warning}\n`);
  }
  process.stdout.write(`stop signal written for session ${sessionId}\n`);
};

/**
 * Wire `cognit agent (run | status | stop)` into the commander
 * program. Called from `index.ts` alongside the other commands.
 */
export function registerAgent(program: Command): void {
  const agent = program
    .command("agent")
    .description("drive the AI supervisor loop (phase C3)");

  agent
    .command("run")
    .description("run the supervisor loop on a session (foreground)")
    .option("--session <id>", "session id (ULID). Defaults to the sticky current-session pointer.")
    .option(
      "--model <id>",
      "Gateway model id (e.g. anthropic/claude-sonnet-4-6). Defaults to llm.default_model / llm.commands.agent_run.model, or mock-1 when none is set.",
    )
    .option("--once", "run a single tick and exit (default: loop until stop)")
    .option(
      "--max-ticks <n>",
      "stop after N ticks (default: unlimited)",
      (v: string) => Number(v),
    )
    .option(
      "--tick-interval-ms <n>",
      "sleep between ticks in milliseconds (default: 5000)",
      (v: string) => Number(v),
    )
    .action(async (opts: RunOptions) => {
      await runCommand(opts);
    });

  agent
    .command("status")
    .description("show supervisor state (running, tick count, last tick id)")
    .option("--session <id>", "session id (ULID). Defaults to the sticky current-session pointer.")
    .action(async (opts: StatusOptions) => {
      await statusCommand(opts);
    });

  agent
    .command("stop")
    .description("request the running supervisor loop to exit (idempotent)")
    .option("--session <id>", "session id (ULID). Defaults to the sticky current-session pointer.")
    .action(async (opts: StopOptions) => {
      await stopCommand(opts);
    });
}
