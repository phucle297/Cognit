/**
 * Public surface for the verification engine.
 *
 *   - `runVerification` is the composer: it owns the spawn → capture →
 *     artifact → onTerminal pipeline. The caller injects `onTerminal`
 *     so this package stays free of `@cognit/db` (no cycle; the
 *     CognitionService lives in `db` and depends back on
 *     `verification`'s types via the public surface).
 *
 *   - `spawnVerification` / `writeArtifact` / `sha256` /
 *     `truncateExcerpt` are re-exported for direct use by tests and
 *     by future higher-level helpers (rerun, batch, …).
 *
 * Terminal state mapping (per AC):
 *
 *   - `ENOENT`  -> `verification_errored` with `error_code="enoent"`
 *   - `EACCES`  -> `verification_errored` with `error_code="eacces"`
 *   - `EPERM`   -> `verification_errored` with `error_code="eperm"`
 *   - other     -> `verification_errored` (no `error_code`)
 *   - exit 0    -> `verification_passed` (with stdout/duration/exit/artifact)
 *   - exit !=0  -> `verification_failed` (with stderr/stdout/duration/exit/artifact)
 */
import { Effect } from "effect";
import { spawnVerification, type SpawnError } from "./spawn.js";
import { truncateExcerpt, shouldWriteArtifact } from "./capture.js";
import { writeArtifact, type ArtifactRef } from "./artifact.js";

export { spawnVerification, type SpawnError, type SpawnErrorCode, type SpawnInput, type SpawnResult } from "./spawn.js";
export { truncateExcerpt, TRUNCATE_BYTES, shouldWriteArtifact, TRUNCATION_SENTINEL } from "./capture.js";
export { writeArtifact, sha256, type ArtifactRef, type ArtifactPaths } from "./artifact.js";

export type VerificationKind = "test" | "lint" | "build" | "exec" | "typecheck";

export type TerminalEventType =
  | "verification_passed"
  | "verification_failed"
  | "verification_errored";

export interface TerminalEvent {
  readonly type: TerminalEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RunVerificationInput {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly paths: { readonly artifacts: string };
  readonly onTerminal: (event: TerminalEvent) => Effect.Effect<void, never>;
}

export interface RunVerificationOutput {
  readonly terminal: TerminalEvent;
  readonly artifact: ArtifactRef | null;
  readonly error: SpawnError | null;
}

/**
 * Run a subprocess and emit a single terminal event via `onTerminal`.
 *
 *   - Always resolves with a `RunVerificationOutput` describing which
 *     terminal event was emitted, whether an artifact was written, and
 *     (on `verification_errored`) the original typed `SpawnError`.
 *   - The caller is expected to be inside an Effect context and to
 *     have already created the `verification_started` event upstream.
 */
export const runVerification = (
  input: RunVerificationInput,
): Effect.Effect<RunVerificationOutput, never> =>
  Effect.gen(function* () {
    const either = yield* Effect.either(spawnVerification(input));

    if (either._tag === "Left") {
      const err = either.left;
      const payload: Record<string, unknown> = { error: err.message };
      if (err.code !== "other") payload.error_code = err.code;
      const terminal: TerminalEvent = {
        type: "verification_errored",
        payload,
      };
      yield* input.onTerminal(terminal);
      return { terminal, artifact: null, error: err } satisfies RunVerificationOutput;
    }

    const { exitCode, stdout, stderr, durationMs } = either.right;
    const stdoutExcerpt = truncateExcerpt(stdout);
    const stderrExcerpt = truncateExcerpt(stderr);

    let artifact: ArtifactRef | null = null;
    if (shouldWriteArtifact(stdout, stderr)) {
      // stdout first, then stderr, separated by a divider. The
      // divider makes the artifact self-describing without changing
      // the sha256 semantics (a different ordering → different sha,
      // which is the desired property).
      const merged = `=== STDOUT ===\n${stdout}\n=== STDERR ===\n${stderr}`;
      artifact = yield* writeArtifact({ paths: input.paths, text: merged });
    }

    const baseFields: Record<string, unknown> = {
      exit_code: exitCode,
      duration_ms: durationMs,
      stdout_excerpt: stdoutExcerpt,
    };
    if (artifact) baseFields.created_artifact_id = artifact.id;

    if (exitCode === 0) {
      const terminal: TerminalEvent = {
        type: "verification_passed",
        payload: baseFields,
      };
      yield* input.onTerminal(terminal);
      return { terminal, artifact, error: null } satisfies RunVerificationOutput;
    }

    const failedPayload: Record<string, unknown> = {
      ...baseFields,
      stderr_excerpt: stderrExcerpt,
    };
    const terminal: TerminalEvent = {
      type: "verification_failed",
      payload: failedPayload,
    };
    yield* input.onTerminal(terminal);
    return { terminal, artifact, error: null } satisfies RunVerificationOutput;
  });
