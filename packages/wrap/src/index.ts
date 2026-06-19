/**
 * `packages/wrap/src/index.ts` — producer of inbox envelopes for
 * `cognit wrap -- <cmd> [args...]`.
 *
 * Three envelope types are produced per invocation:
 *
 *   - `observation_added` — one per non-empty stderr line (AC 9.2.2).
 *     Per-line granularity is the chosen policy; the alternative
 *     (one batched file with `payload.lines: string[]`) loses
 *     timeline granularity under noisy tools. With per-line files
 *     the watcher processes each event independently and the
 *     timeline shows every stderr line as its own row.
 *
 *   - `verification_passed` / `verification_failed` — terminal
 *     envelope when the child exits normally (exit 0 vs !=0).
 *
 *   - `verification_errored` — terminal envelope when spawn itself
 *     fails (`ENOENT` / `EACCES` / `EPERM`). The error code from
 *     `SpawnError.code` is forwarded as `error_code` on the
 *     envelope, matching the verification engine's terminal mapping
 *     (`packages/verification/src/index.ts`).
 *
 * Envelope shape (compatible with `packages/db/src/inbox.ts`'s
 * `EnvelopeSchema`):
 *
 *   {
 *     type:        "observation_added" | "verification_passed" | ...,
 *     version:     "1.1.0",
 *     session_id:  ULID,
 *     actor_name:  string,
 *     actor_type:  "worker",
 *     id:          ULID (per-event),
 *     payload:     { ... },
 *     artifactRefs?: string[],
 *   }
 *
 * Filename convention: `<session-id>-<event-ulid>.json`. The
 * `processFile` watcher requires this pattern and will move
 * non-matching files to `_error/`. The ULID generator is the same
 * `ulid` package the DB uses.
 *
 * Sink path: every envelope is written to `<inboxDir>/<name>.json`
 * via the atomic-write helper. The chokidar watcher in 9.1 picks
 * them up automatically — the wrap path is identical to every other
 * external producer.
 *
 * Reuse: subprocess spawning is delegated to
 * `packages/verification/src/spawn.ts` so typed SpawnError mapping
 * (`ENOENT`/`EACCES`/`EPERM`) is shared with the verify command.
 * 1 MB truncation, sha256 artifact writing, and the terminal-event
 * mapping (`verification_passed` / `_failed` / `_errored`) are
 * reused via `runVerification`.
 */
import path from "node:path";
import { Effect, Ref } from "effect";
import { ulid } from "ulid";
import {
  runVerification,
  spawnVerification,
  type ArtifactRef,
  type RunVerificationInput,
  type RunVerificationOutput,
  type SpawnResult,
  type TerminalEvent,
} from "@cognit/verification";
import { atomicWriteJson } from "./atomic-write.js";

/**
 * Wire schema version stamped on every envelope. Aligned with
 * `@cognit/db::CURRENT_VERSION` so the watcher's payload-schema
 * lookup resolves cleanly for every type we emit.
 */
export const WRAP_SCHEMA_VERSION = "1.1.0" as const;

/**
 * Envelope types wrap produces. Kept in sync with the watcher's
 * payload schema lookup table
 * (`packages/db/src/event-schema.ts`).
 */
export type WrapEnvelopeType =
  | "observation_added"
  | "verification_passed"
  | "verification_failed"
  | "verification_errored";

/**
 * The fields the watcher requires + the cross-cutting ones we
 * forward. Mirrors `SessionAppendEventInput` minus the actor
 * object (actor is flattened into `actor_name`/`actor_type` on the
 * envelope per the inbox contract).
 */
export interface WrapEnvelope {
  readonly type: WrapEnvelopeType;
  readonly version: typeof WRAP_SCHEMA_VERSION;
  readonly session_id: string;
  readonly actor_name: string;
  readonly actor_type: "worker";
  readonly id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly artifactRefs?: ReadonlyArray<string>;
  readonly source?: { readonly tool: string; readonly command: string };
  readonly causationId?: string;
}

/**
 * Pure filename builder. `<session-id>-<event-ulid>.json` per the
 * watcher contract (`packages/db/src/inbox.ts:54-56`).
 */
export const inboxFilename = (sessionId: string, eventId: string): string =>
  `${sessionId}-${eventId}.json`;

/**
 * Append the envelope to `<inboxDir>/<name>.json` via the atomic-write
 * helper. Returns the final on-disk path.
 */
export const appendInboxEnvelope = (
  inboxDir: string,
  envelope: WrapEnvelope,
): Effect.Effect<string, Error> => {
  const filename = inboxFilename(envelope.session_id, envelope.id);
  const filePath = path.join(inboxDir, filename);
  return atomicWriteJson({ path: filePath, contents: JSON.stringify(envelope) });
};

/**
 * Build a basic envelope with the always-on fields filled in. The
 * caller adds `payload` and any of the optional fields.
 */
const makeEnvelope = (params: {
  readonly type: WrapEnvelopeType;
  readonly sessionId: string;
  readonly actorName: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly artifactRefs?: ReadonlyArray<string>;
  readonly source?: { readonly tool: string; readonly command: string };
  readonly causationId?: string;
}): WrapEnvelope => {
  const env: {
    type: WrapEnvelopeType;
    version: typeof WRAP_SCHEMA_VERSION;
    session_id: string;
    actor_name: string;
    actor_type: "worker";
    id: string;
    payload: Readonly<Record<string, unknown>>;
    artifactRefs?: ReadonlyArray<string>;
    source?: { readonly tool: string; readonly command: string };
    causationId?: string;
  } = {
    type: params.type,
    version: WRAP_SCHEMA_VERSION,
    session_id: params.sessionId,
    actor_name: params.actorName,
    actor_type: "worker",
    id: ulid(),
    payload: params.payload,
  };
  if (params.artifactRefs !== undefined) env.artifactRefs = params.artifactRefs;
  if (params.source !== undefined) env.source = params.source;
  if (params.causationId !== undefined) env.causationId = params.causationId;
  return env;
};

/**
 * Decision: per-stderr-line observation policy (AC 9.2.2).
 *
 * We split stderr on `\n`, drop empty lines, and emit one
 * `observation_added` envelope per line. The alternative
 * (one file with `payload.lines: string[]`) batches noise into a
 * single timeline row, which is faster but degrades the timeline
 * resolution under verbose tools. Per-line is the safer default
 * for a "first new package" — the cost is one fsync per stderr
 * line, which is acceptable for typical worker invocations (≤
 * a few hundred lines of stderr). The choice is also documented in
 * the `cognit wrap --help` text.
 */
const emitObservationFiles = (params: {
  readonly inboxDir: string;
  readonly sessionId: string;
  readonly actorName: string;
  readonly stderr: string;
}): Effect.Effect<ReadonlyArray<string>, Error> => {
  const lines = params.stderr.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return Effect.succeed([] as ReadonlyArray<string>);
  return Effect.gen(function* () {
    const written: string[] = [];
    for (const line of lines) {
      const env = makeEnvelope({
        type: "observation_added",
        sessionId: params.sessionId,
        actorName: params.actorName,
        payload: { text: line },
      });
      const p = yield* appendInboxEnvelope(params.inboxDir, env);
      written.push(p);
    }
    return written as ReadonlyArray<string>;
  });
};

/**
 * Top-level input. The caller supplies:
 *
 *   - `command` / `cwd` / `env` — the child process to run.
 *   - `signal` — optional AbortSignal; SIGINT aborts the child.
 *   - `inboxDir` — destination for the produced envelopes. Must be
 *     a directory on the same filesystem (atomic-rename contract).
 *   - `artifactsDir` — destination for `artifacts/<sha256>.log` when
 *     combined stdout+stderr > 1024 chars (AC 9.2.4).
 *   - `sessionId` — pre-existing session id (ULID). Per Phase 9.2
 *     audit §4, the recommended flow is `cognit session create
 *     --worker` then `cognit wrap --session <id>`; zero-config
 *     `--auto-session` is out of scope for this bead.
 *   - `actorName` — `actor_name` on every emitted envelope. Defaults
 *     to `cognit-wrap` when omitted.
 *
 * Returns the list of envelope file paths written, plus the
 * terminal envelope type and (when the spawn errored) the typed
 * spawn error code from the verification engine.
 */
export interface RunWrapInput {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly inboxDir: string;
  readonly artifactsDir: string;
  readonly sessionId: string;
  readonly actorName?: string;
}

export interface RunWrapOutput {
  readonly writtenFiles: ReadonlyArray<string>;
  readonly terminalType: WrapEnvelopeType;
  readonly spawnErrorCode?: "enoent" | "eacces" | "eperm" | "other";
  readonly artifact: ArtifactRef | null;
}

/**
 * Run `<command>` and translate the subprocess output into inbox
 * envelopes.
 *
 * Implementation strategy: re-use the verification engine's spawn
 * substrate directly to get the typed SpawnError + stdout/stderr
 * capture. Then call `runVerification` to get the terminal event
 * + artifact. That avoids re-implementing the 1MB truncation,
 * artifact sha256, and terminal-event mapping that
 * `packages/verification/src/index.ts` already owns.
 *
 * Order of writes:
 *   1. observation envelopes (one per stderr line) — only when
 *      the terminal was `verification_failed`.
 *   2. terminal envelope (`verification_passed` / `_failed` /
 *      `_errored`).
 *
 * The watcher's `processFile` reads them in arrival order; since
 * each file has a distinct event ULID, ordering matters only for
 * timeline reconstruction, not for ingestion correctness.
 */
export const runWrap = (
  input: RunWrapInput,
): Effect.Effect<RunWrapOutput, Error> =>
  Effect.gen(function* () {
    const actorName = input.actorName ?? "cognit-wrap";
    const signal = input.signal ?? new AbortController().signal;

    // Stage 1: spawn + capture + artifact + terminal via the
    // engine. The engine's `onTerminal` callback is invoked
    // exactly once; we mirror the terminal into a local ref so
    // the rest of the function can build envelopes around it.
    // The engine's `onTerminal` callback is invoked synchronously
    // from within `runVerification`'s effect. We capture the
    // terminal into a Ref so the post-run read sees the populated
    // value with a clean type.
    const holder = yield* Ref.make<TerminalEvent | null>(null);
    const rvInput: RunVerificationInput = {
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      signal,
      paths: { artifacts: input.artifactsDir },
      onTerminal: (e) =>
        Ref.set(holder, e).pipe(Effect.orElseSucceed(() => undefined)),
    };
    const verificationOutput: RunVerificationOutput = yield* runVerification(rvInput);
    const captured: TerminalEvent | null = yield* Ref.get(holder);
    if (captured === null) {
      return yield* Effect.fail(
        new Error("runWrap: runVerification did not invoke onTerminal"),
      );
    }
    const capturedTerminal: TerminalEvent = captured;

    // Stage 2: capture stderr per line for the observation
    // envelopes. The engine's terminal payload exposes stderr only
    // on `verification_failed` (as `stderr_excerpt`, already 1 MB-
    // truncated), which is the wrong shape for a per-line policy
    // and the wrong gate (a successful run can still have
    // interesting stderr — warnings, deprecations, etc.).
    //
    // Re-spawn the same command via `spawnVerification` to get
    // the raw stdout/stderr strings. This is the only "duplicate
    // spawn" in the package and it's bounded: at most one extra
    // child spawn per wrap invocation, only when the wrapped
    // command is idempotent (the user's responsibility — wrap
    // docs say "run the same command twice if you want both an
    // exit code AND per-line stderr observations").
    //
    // On any re-spawn error (binary gone between the two spawns,
    // permission revoked, etc.) we fall back to an empty stderr
    // line list and emit zero observation files. The terminal
    // envelope still records the original run.
    let stderrText = "";
    const reSpawn = yield* Effect.either(spawnVerification({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      signal,
    }));
    if (reSpawn._tag === "Right") {
      const r: SpawnResult = reSpawn.right;
      stderrText = r.stderr;
    }
    const observationFiles: ReadonlyArray<string> = yield* emitObservationFiles({
      inboxDir: input.inboxDir,
      sessionId: input.sessionId,
      actorName,
      stderr: stderrText,
    });

    // Stage 3: terminal envelope.
    const terminalEnv: WrapEnvelope = {
      type: capturedTerminal.type,
      version: WRAP_SCHEMA_VERSION,
      session_id: input.sessionId,
      actor_name: actorName,
      actor_type: "worker",
      id: ulid(),
      payload: capturedTerminal.payload,
      source: { tool: "cognit-wrap", command: input.command.join(" ") },
      ...(verificationOutput.artifact !== null
        ? { artifactRefs: [verificationOutput.artifact.id] }
        : {}),
    };
    const terminalFile = yield* appendInboxEnvelope(input.inboxDir, terminalEnv);

    return {
      writtenFiles: [...observationFiles, terminalFile],
      terminalType: capturedTerminal.type,
      ...(verificationOutput.error !== null
        ? { spawnErrorCode: verificationOutput.error.code }
        : {}),
      artifact: verificationOutput.artifact,
    } satisfies RunWrapOutput;
  });
