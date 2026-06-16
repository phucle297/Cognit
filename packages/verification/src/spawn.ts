/**
 * `spawnVerification` — the only allowed way to launch a subprocess from
 * the verification engine. Node's `child_process.spawn` is wrapped so that:
 *
 *   - `ENOENT` / `EACCES` / `EPERM` from the kernel are surfaced as typed
 *     `SpawnError` with a stable `code` field. The `onTerminal` callback
 *     reads that code and emits `verification_errored` with
 *     `error_code=<code>` per AC.
 *   - any other `error` event becomes `SpawnError { code: "other" }` so
 *     callers never receive a raw `Error`.
 *   - the spawned child respects an `AbortSignal` (caller-supplied; the
 *     verification lifecycle is the one that should wire it).
 *   - `stdout` / `stderr` are accumulated as strings for the caller. We
 *     do NOT cap them here — capture.ts owns the 1 MB excerpt.
 *
 * The return shape is intentionally narrow: `{ exitCode, stdout, stderr,
 * durationMs, error? }`. The `error` field is only set on the happy
 * spawn-but-spawn-failed path. On `tryPromise` rejection we short-circuit
 * with a `SpawnError` so `Effect.either` callers see a typed failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Effect } from "effect";

export type SpawnErrorCode = "enoent" | "eacces" | "eperm" | "other";

export interface SpawnError {
  readonly _tag: "SpawnError";
  readonly code: SpawnErrorCode;
  readonly message: string;
}

const makeSpawnError = (e: NodeJS.ErrnoException): SpawnError => {
  let code: SpawnErrorCode = "other";
  if (e.code === "ENOENT") code = "enoent";
  else if (e.code === "EACCES") code = "eacces";
  else if (e.code === "EPERM") code = "eperm";
  return { _tag: "SpawnError", code, message: e.message };
};

export interface SpawnInput {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}

export interface SpawnResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/**
 * Launch a child process, capture stdout/stderr, resolve with the exit
 * code (or `-1` if killed by a signal), and the wall-clock duration.
 *
 * On `ENOENT`/`EACCES`/`EPERM` the Effect fails with a `SpawnError`.
 * The caller (index.ts) maps that to a `verification_errored` event
 * with `error_code` set to the typed code.
 */
export const spawnVerification = (
  input: SpawnInput,
): Effect.Effect<SpawnResult, SpawnError> =>
  Effect.gen(function* () {
    if (input.command.length === 0) {
      return yield* Effect.fail<SpawnError>({
        _tag: "SpawnError",
        code: "other",
        message: "spawnVerification: command array must be non-empty",
      });
    }
    const [cmd, ...args] = input.command;
    // We asserted non-empty above, but noUncheckedIndexedAccess keeps
    // `cmd` as `string | undefined`. Use a runtime guard that TS can
    // narrow through.
    if (typeof cmd !== "string") {
      return yield* Effect.fail<SpawnError>({
        _tag: "SpawnError",
        code: "other",
        message: "spawnVerification: command[0] must be a string",
      });
    }
    const started = Date.now();
    // The `signal` option makes `spawn`'s overload resolution return a
    // union of incompatible stream types (ChildProcessWithoutNullStreams
    // vs ChildProcessByStdio). Cast to the common base — every variant
    // has the same `once` + nullable-stdout/stderr surface we use.
    const child = spawn(cmd, args, {
      cwd: input.cwd,
      env: input.env,
      signal: input.signal,
    }) as unknown as ChildProcess;
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });

    const closed = yield* Effect.tryPromise({
      try: () =>
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once("error", (err: unknown) => {
            reject(err);
          });
          child.once("close", (code, signal) => {
            resolve({ code, signal });
          });
        }),
      catch: (e) => makeSpawnError(e as NodeJS.ErrnoException),
    });

    return {
      exitCode: closed.code ?? -1,
      signal: closed.signal,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    } satisfies SpawnResult;
  });
