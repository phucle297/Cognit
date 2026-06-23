/**
 * apps/cli/src/agent-state.ts — pidfile + stop sentinel + tick-state
 * helpers for the `cognit agent (run | status | stop)` subcommands.
 *
 * Three on-disk artefacts under `.cognit/`:
 *
 *   - `agent.<sid>.pid`      — writer: `run` (start). reader: `run`
 *                              (conflict guard), `status` (liveness).
 *   - `agent.<sid>.stop`     — writer: `stop`. reader: `run` (between
 *                              ticks). Idempotent — the run loop
 *                              removes the file after observing it.
 *   - `agent.<sid>.state.json` — writer: `run` (after each tick).
 *                                reader: `status`.
 *
 * No business logic. Just FS wrappers with atomic writes (tmp + rename)
 * so a crash mid-write does not leave a half-baked state file. Mirrors
 * the pattern from `current-session.ts`.
 */
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cognitDir } from "./paths.js";

/** Path helpers — pure. */
export const agentPidPath = (projectRoot: string, sessionId: string): string =>
  path.join(cognitDir(projectRoot), `agent.${sessionId}.pid`);

export const agentStopPath = (projectRoot: string, sessionId: string): string =>
  path.join(cognitDir(projectRoot), `agent.${sessionId}.stop`);

export const agentStatePath = (projectRoot: string, sessionId: string): string =>
  path.join(cognitDir(projectRoot), `agent.${sessionId}.state.json`);

/** Sentinel-shaped state written after every tick. */
export interface AgentRunState {
  readonly last_tick_id: string | null;
  readonly tick_count: number;
  readonly last_decision_kind: "stop" | "actions" | "rank_overrides" | "empty";
  readonly provider: string;
  readonly model: string;
  readonly started_at: string;
  readonly updated_at: string;
}

/** Result of probing whether an agent is alive for a session. */
export interface AgentLiveness {
  readonly pid: number | null;
  readonly running: boolean;
}

/**
 * Cheap liveness check. `process.kill(pid, 0)` throws `ESRCH` if the
 * process is gone, `EPERM` if the pid belongs to another user.
 *
 * We treat any throw as "not alive" — for the local-first CLI, an
 * EPERM means our pidfile points at a process we don't own, which is
 * effectively dead for our purposes (we cannot stop it).
 */
export const probeLiveness = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
};

/** Read the pidfile. Returns `null` when missing or malformed. */
export const readPidfile = async (
  projectRoot: string,
  sessionId: string,
): Promise<number | null> => {
  const p = agentPidPath(projectRoot, sessionId);
  if (!existsSync(p)) return null;
  try {
    const text = (await fs.readFile(p, "utf8")).trim();
    const n = Number.parseInt(text, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
};

/** Write `process.pid` to the pidfile. Best-effort — errors propagate. */
export const writePidfile = async (
  projectRoot: string,
  sessionId: string,
  pid: number = process.pid,
): Promise<void> => {
  await fs.writeFile(agentPidPath(projectRoot, sessionId), String(pid), {
    mode: 0o600,
  });
};

/**
 * Atomic pidfile claim. Writes to `<path>.tmp` first with the
 * `O_CREAT | O_EXCL | O_WRONLY` flags (Node's `"wx"`), fsyncs, then
 * renames over the final path. This is the same pattern as
 * `packages/wrap/src/atomic-write.ts` and `current-session.ts`.
 *
 * Returns `true` if this process now owns the pidfile, `false` if
 * another process raced ahead of us and the pidfile is held by
 * someone else (the caller should re-probe to surface the conflict).
 *
 * EEXIST on the temp write is the race-loser case — the other
 * process is mid-claim. We also refuse the claim when the final
 * pidfile already exists (POSIX `rename(2)` would atomically
 * clobber it, which would mask a live agent); the caller treats
 * that as "another agent holds the slot" and the re-probe will
 * surface the live pid.
 */
export const claimPidfile = async (
  projectRoot: string,
  sessionId: string,
  pid: number = process.pid,
): Promise<boolean> => {
  const final = agentPidPath(projectRoot, sessionId);
  // Pre-check the final path. The `wx` flag on the temp guarantees
  // we don't race with another claimer, but `fs.rename` would
  // silently clobber a pre-existing final pidfile — and that
  // pre-existing file is the whole point of the conflict guard.
  if (existsSync(final)) return false;
  const tmp = `${final}.tmp`;
  let fd: import("node:fs/promises").FileHandle | null = null;
  try {
    // Mode 0o600: only the owner can read the pidfile (which holds
    // our process pid — not secret, but the principal-of-least-
    // privilege default). `"wx"` refuses to open an existing file,
    // so a stale `.tmp` from a crashed prior claim cannot be silently
    // truncated. Concurrent claimers race on this open; exactly one
    // wins, the rest get EEXIST.
    fd = await fs.open(tmp, "wx", 0o600);
    await fd.writeFile(String(pid));
    await fd.sync();
    await fd.close();
    fd = null;
  } catch (e) {
    if (fd !== null) {
      try {
        await fd.close();
      } catch {
        /* swallow */
      }
    }
    try {
      await fs.unlink(tmp);
    } catch {
      /* swallow */
    }
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  // Re-check the final path after the temp write completes. The
  // window between `existsSync(final)` above and this `rename` is
  // small but non-zero — another claimer could have created the
  // final in the meantime. The `wx` flag on the temp file is what
  // actually prevents the race: only one claimer can ever produce
  // a `.tmp` to rename from.
  if (existsSync(final)) {
    try {
      await fs.unlink(tmp);
    } catch {
      /* swallow */
    }
    return false;
  }
  try {
    await fs.rename(tmp, final);
  } catch (e) {
    try {
      await fs.unlink(tmp);
    } catch {
      /* swallow */
    }
    throw e;
  }
  return true;
};

/** Remove the pidfile. Silent when already gone. */
export const clearPidfile = async (
  projectRoot: string,
  sessionId: string,
): Promise<void> => {
  try {
    await fs.unlink(agentPidPath(projectRoot, sessionId));
  } catch {
    /* swallow — ENOENT is the common case */
  }
};

/** Touch the stop sentinel. Idempotent. */
export const requestStop = async (
  projectRoot: string,
  sessionId: string,
): Promise<void> => {
  const p = agentStopPath(projectRoot, sessionId);
  await fs.writeFile(p, new Date().toISOString(), { mode: 0o600 });
};

/** Returns `true` when the stop sentinel is present, removing it atomically. */
export const consumeStop = async (
  projectRoot: string,
  sessionId: string,
): Promise<boolean> => {
  const p = agentStopPath(projectRoot, sessionId);
  if (!existsSync(p)) return false;
  try {
    await fs.unlink(p);
    return true;
  } catch {
    return false;
  }
};

/** Read the tick-state JSON. Returns `null` when missing/corrupt. */
export const readAgentState = async (
  projectRoot: string,
  sessionId: string,
): Promise<AgentRunState | null> => {
  const p = agentStatePath(projectRoot, sessionId);
  if (!existsSync(p)) return null;
  try {
    const text = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(text) as AgentRunState;
    // Minimal shape check — anything else would be a corruption we
    // want to surface (not silently coerce).
    if (
      typeof parsed.tick_count !== "number" ||
      typeof parsed.started_at !== "string" ||
      typeof parsed.updated_at !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

/**
 * Atomic write for tick state. Writes to `.tmp` then renames so a
 * crash mid-write cannot leave a half-baked JSON file. Mirrors the
 * pattern used by `current-session.ts` (3.5 atomic-write race hardening).
 */
export const writeAgentState = async (
  projectRoot: string,
  sessionId: string,
  state: AgentRunState,
): Promise<void> => {
  const final = agentStatePath(projectRoot, sessionId);
  const tmp = `${final}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, final);
};

/**
 * Combined `running` probe for `status`. Returns the pid (when the
 * pidfile exists) and whether `kill(pid, 0)` succeeds. A stale
 * pidfile (alive check fails) is reported as `running: false` but
 * the pid is still surfaced so the operator can decide what to do.
 */
export const probeAgent = async (
  projectRoot: string,
  sessionId: string,
): Promise<AgentLiveness> => {
  const pid = await readPidfile(projectRoot, sessionId);
  if (pid === null) return { pid: null, running: false };
  return { pid, running: probeLiveness(pid) };
};