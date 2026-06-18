import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { CognitionService, type ActorType, type VerificationType } from "@cognit/db";
import { runVerification, type TerminalEvent } from "@cognit/verification";
import { findProjectRoot, projectPaths } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";

interface VerifyOptions {
  session?: string;
  type?: string;
  actor?: string;
  root?: string;
  linkedHypothesis?: string;
  parentVerification?: string;
  reason?: string;
  exitCode?: string;
  durationMs?: string;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  createdArtifactId?: string;
  error?: string;
  errorCode?: string;
}

const VALID_ACTOR_TYPES: ReadonlySet<ActorType> = new Set<ActorType>(["human", "worker", "system"]);
const VALID_VERIFICATION_TYPES: ReadonlySet<VerificationType> = new Set<VerificationType>([
  "test",
  "lint",
  "build",
  "exec",
  "typecheck",
]);

const parseActor = (
  raw: string | undefined,
  defaultName: string,
  defaultType: ActorType,
): { name: string; type: ActorType } => {
  if (!raw) return { name: defaultName, type: defaultType };
  const idx = raw.lastIndexOf(":");
  if (idx < 0) {
    return { name: raw, type: defaultType };
  }
  const name = raw.slice(0, idx);
  const type = raw.slice(idx + 1) as ActorType;
  if (!VALID_ACTOR_TYPES.has(type)) {
    process.stderr.write(`cognit: --actor type must be one of human|worker|system, got: ${type}\n`);
    process.exitCode = 2;
    return { name: defaultName, type: defaultType };
  }
  return { name: name || defaultName, type };
};

const parseVerificationType = (raw: string | undefined): VerificationType => {
  if (!raw) {
    process.stderr.write("cognit: --type is required (test|lint|build|exec|typecheck)\n");
    process.exitCode = 2;
    throw new Error("--type: missing");
  }
  if (!VALID_VERIFICATION_TYPES.has(raw as VerificationType)) {
    process.stderr.write(
      `cognit: --type must be one of test|lint|build|exec|typecheck, got: ${raw}\n`,
    );
    process.exitCode = 2;
    throw new Error("--type: invalid");
  }
  return raw as VerificationType;
};

const resolveProjectRoot = (raw: string | undefined): string => {
  if (raw) return raw;
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write("cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n");
    process.exitCode = 2;
    throw new Error("not in a cognit project");
  }
  return root;
};

interface CliEvent {
  readonly id: string;
  readonly type: string;
  readonly session_id: string;
  readonly created_at: string;
  readonly parent_verification_id: string | null;
}

const runEffect = async (
  eff: Effect.Effect<CliEvent, unknown, never>,
  label: string,
): Promise<CliEvent> => {
  const exit = await Effect.runPromiseExit(eff);
  if (Exit.isFailure(exit)) {
    const err = Cause.failureOption(exit.cause);
    if (err._tag === "Some") {
      const fail = err.value as {
        _tag?: string;
        type?: string;
        sessionId?: string;
        issues?: string;
        message?: string;
      };
      switch (fail._tag) {
        case "UnknownEventType":
          process.stderr.write(`cognit: --type "${fail.type}" is not a known event type\n`);
          break;
        case "UnknownSession":
          process.stderr.write(`cognit: --session "${fail.sessionId}" does not exist\n`);
          break;
        case "SessionClosed":
          process.stderr.write(`cognit: --session "${fail.sessionId}" is closed\n`);
          break;
        case "ValidationFailure":
          process.stderr.write(
            `cognit: ${label} payload failed schema validation: ${fail.issues}\n`,
          );
          break;
        case "DbError":
          process.stderr.write(`cognit: ${fail.message ?? String(fail)}\n`);
          break;
        default:
          process.stderr.write(`cognit: ${fail.message ?? String(fail)}\n`);
      }
    } else {
      const die = Cause.dieOption(exit.cause);
      if (die._tag === "Some") {
        process.stderr.write(`cognit: ${String(die.value)}\n`);
      } else {
        process.stderr.write(`cognit: ${label} failed\n`);
      }
    }
    if (process.exitCode === undefined) process.exitCode = 1;
    throw new Error(`${label}: failed`);
  }
  return exit.value;
};

const printEvent = (event: CliEvent): void => {
  process.stdout.write(`event:    ${event.id}\n`);
  process.stdout.write(`type:     ${event.type}\n`);
  process.stdout.write(`session:  ${event.session_id}\n`);
  process.stdout.write(`time:     ${event.created_at}\n`);
};

const requireSessionId = (root: string, raw: string | undefined): string => {
  const resolved = resolveSessionId(root, raw);
  if (!resolved) {
    process.stderr.write(
      "cognit: --session is required (or run `cognit session create` to set the sticky pointer)\n",
    );
    process.exitCode = 2;
    throw new Error("--session: missing");
  }
  if (resolved.source === "pointer") warnStalePointer(root, resolved.sessionId);
  return resolved.sessionId;
};

const parseOptionalInt = (raw: string | undefined, flag: string): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    process.stderr.write(`cognit: ${flag} must be an integer, got: ${raw}\n`);
    process.exitCode = 2;
    throw new Error(`${flag}: invalid`);
  }
  return n;
};

/**
 * `cognit verify` command family (Phase 4 / 6bz.3).
 *
 *   - `cognit verify <command> --type <t> --session <id>` — start a
 *     verification AND run it inline via the subprocess engine. Emits
 *     `verification_started` immediately, then the terminal event
 *     (`verification_passed` / `_failed` / `_errored`) once the
 *     subprocess settles.
 *   - `cognit verify cancel --id <vid> --reason "..." --session <id>`
 *     emits `verification_cancelled`.
 *   - `cognit verify pass|fail|error|rerun <vid>` are explicit
 *     injection paths for external drivers (HTTP API, `cognit wrap`).
 *     They route through `CognitionService` directly without spawning
 *     a subprocess.
 *
 * All subcommands honour `--json` for a parseable envelope; without
 * `--json`, they print a human-readable event header (`event:`,
 * `type:`, `session:`, `time:`).
 */
export function registerVerification(program: Command): void {
  const verify = program
    .command("verify")
    .description(
      "verification lifecycle: run (default), cancel, pass, fail, error, rerun",
    );

  // ---------------------------------------------------------------
  // Default: `cognit verify <command>` — start + auto-run via engine
  // ---------------------------------------------------------------
  verify
    .option("--type <kind>", "verification type: test|lint|build|exec|typecheck")
    .option("--session <id>", "session id (ULID)")
    .option("--linked-hypothesis <id>", "hypothesis id (ULID) this verification checks")
    .option("--parent-verification <id>", "parent verification id (for rerun chains)")
    .option("--reason <text>", "cancellation reason [for cancel]")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .argument("[command...]", "the command to run (e.g. `pnpm test`)")
    .action(async (command: string[] | undefined, opts: VerifyOptions) => {
      // Commander gives us an array of positional tokens. `cognit
      // verify cancel ...` is dispatched by the `cancel` subcommand,
      // so by the time we land here `command` should be the actual
      // command to run.
      const argv = command ?? [];
      if (argv.length === 0) {
        process.stderr.write(
          "cognit: verify requires a <command> positional (e.g. `pnpm test`); for cancel, use `cognit verify cancel --id <vid> --reason <text> --session <sid>`\n",
        );
        process.exitCode = 2;
        throw new Error("verify: missing command");
      }
      const root = resolveProjectRoot(opts.root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const type = parseVerificationType(opts.type);
      const sessionId = requireSessionId(root, opts.session);

      // Step 1: append `verification_started` (this is the row whose
      // id we thread into the terminal event's parent_verification_id).
      const startProgram = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.verify({
          sessionId,
          command: argv.join(" "),
          type,
          actor,
          ...(opts.linkedHypothesis !== undefined
            ? { linkedHypothesisId: opts.linkedHypothesis }
            : {}),
          ...(opts.parentVerification !== undefined
            ? { parentVerificationId: opts.parentVerification }
            : {}),
        });
      });
      const provided = withAppLayer(root, startProgram) as unknown as Effect.Effect<
        CliEvent,
        unknown,
        never
      >;
      const startedEvent = await runEffect(provided, "verify");

      // Step 2: run the subprocess and emit the terminal event.
      const paths = projectPaths(root);
      const ac = new AbortController();
      const onSigint = (): void => {
        ac.abort();
      };
      process.on("SIGINT", onSigint);

      let terminal: TerminalEvent | undefined;
      let artifact: { id: string } | null = null;
      let error: { code: string; message: string } | null = null;
      const runProgram = runVerification({
        command: argv,
        cwd: root,
        env: process.env,
        signal: ac.signal,
        paths: { artifacts: paths.artifacts },
        onTerminal: (e) =>
          Effect.sync(() => {
            terminal = e;
          }),
      });
      // `try/finally` so a thrown engine run still releases the
      // SIGINT listener (the engine's effect is typed `never`, but
      // a defect would otherwise leak the handler).
      try {
        const out = await Effect.runPromise(runProgram);
        artifact = out.artifact;
        error = out.error;
      } finally {
        process.off("SIGINT", onSigint);
      }

      if (!terminal) {
        process.stderr.write("cognit: verify engine produced no terminal event\n");
        process.exitCode = 1;
        throw new Error("verify: no terminal event");
      }

      // Step 3: route the terminal event into CognitionService so it
      // lands in the events table with the right parent_verification_id.
      const terminalProgram = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        const verificationId = startedEvent.id;
        if (terminal!.type === "verification_passed") {
          const p = terminal!.payload as {
            exit_code?: number;
            duration_ms?: number;
            stdout_excerpt?: string;
            created_artifact_id?: string;
          };
          return yield* cognition.passVerification({
            sessionId,
            verificationId,
            actor,
            ...(p.exit_code !== undefined ? { exitCode: p.exit_code } : {}),
            ...(p.duration_ms !== undefined ? { durationMs: p.duration_ms } : {}),
            ...(p.stdout_excerpt !== undefined ? { stdoutExcerpt: p.stdout_excerpt } : {}),
            ...(p.created_artifact_id !== undefined
              ? { createdArtifactId: p.created_artifact_id }
              : {}),
          });
        }
        if (terminal!.type === "verification_failed") {
          const p = terminal!.payload as {
            stderr_excerpt: string;
            exit_code?: number;
            duration_ms?: number;
            stdout_excerpt?: string;
            created_artifact_id?: string;
          };
          return yield* cognition.failVerification({
            sessionId,
            verificationId,
            actor,
            stderrExcerpt: p.stderr_excerpt ?? "",
            ...(p.exit_code !== undefined ? { exitCode: p.exit_code } : {}),
            ...(p.duration_ms !== undefined ? { durationMs: p.duration_ms } : {}),
            ...(p.stdout_excerpt !== undefined ? { stdoutExcerpt: p.stdout_excerpt } : {}),
            ...(p.created_artifact_id !== undefined
              ? { createdArtifactId: p.created_artifact_id }
              : {}),
          });
        }
        const p = terminal!.payload as {
          error: string;
          error_code?: string;
          duration_ms?: number;
        };
        return yield* cognition.errorVerification({
          sessionId,
          verificationId,
          actor,
          error: p.error ?? "verify: spawn failed",
          ...(p.error_code !== undefined ? { errorCode: p.error_code } : {}),
          ...(p.duration_ms !== undefined ? { durationMs: p.duration_ms } : {}),
        });
      });
      const providedTerm = withAppLayer(root, terminalProgram) as unknown as Effect.Effect<
        CliEvent,
        unknown,
        never
      >;
      const terminalEvent = await runEffect(providedTerm, `verify (${terminal.type})`);

      if (getOutputMode() === "json") {
        emit("json", "verification.start", {
          started: startedEvent,
          terminal: terminalEvent,
          terminal_type: terminal.type,
          artifact_id: artifact?.id ?? null,
          error: error
            ? { code: error.code, message: error.message }
            : null,
        });
        return;
      }
      printEvent(startedEvent);
      process.stdout.write("---\n");
      printEvent(terminalEvent);
    });

  // ---------------------------------------------------------------
  // `cognit verify cancel --id <vid> --reason <text> --session <sid>`
  // ---------------------------------------------------------------
  verify
    .command("cancel")
    .description("cancel an in-flight verification (verification_cancelled)")
    .requiredOption("--id <vid>", "verification id (ULID)")
    .requiredOption("--reason <text>", "cancellation reason")
    .option("--session <id>", "session id (ULID)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root")
    .action(
      async (opts: { id: string; reason: string } & VerifyOptions) => {
        const root = resolveProjectRoot(opts.root);
        const actor = parseActor(opts.actor, "cognit-cli", "system");
        const sessionId = requireSessionId(root, opts.session);
        const programEff = Effect.gen(function* () {
          const cognition = yield* CognitionService;
          return yield* cognition.cancelVerification({
            sessionId,
            verificationId: opts.id,
            reason: opts.reason,
            actor,
          });
        });
        const provided = withAppLayer(root, programEff) as unknown as Effect.Effect<
          CliEvent,
          unknown,
          never
        >;
        const event = await runEffect(provided, "verify cancel");
        if (getOutputMode() === "json") {
          emit("json", "verification.cancel", { event });
          return;
        }
        printEvent(event);
      },
    );

  // ---------------------------------------------------------------
  // `cognit verify pass <vid>`
  // ---------------------------------------------------------------
  verify
    .command("pass <vid>")
    .description("inject a verification_passed terminal event (external drivers)")
    .option("--exit-code <n>", "exit code (default 0)")
    .option("--duration-ms <n>", "duration in ms")
    .option("--stdout-excerpt <text>", "stdout excerpt")
    .option("--created-artifact-id <id>", "artifact id (ULID)")
    .option("--session <id>", "session id (ULID)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root")
    .action(async (vid: string, opts: VerifyOptions) => {
      const root = resolveProjectRoot(opts.root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const sessionId = requireSessionId(root, opts.session);
      const exitCode = parseOptionalInt(opts.exitCode, "--exit-code");
      const durationMs = parseOptionalInt(opts.durationMs, "--duration-ms");
      const programEff = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.passVerification({
          sessionId,
          verificationId: vid,
          actor,
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(opts.stdoutExcerpt !== undefined ? { stdoutExcerpt: opts.stdoutExcerpt } : {}),
          ...(opts.createdArtifactId !== undefined
            ? { createdArtifactId: opts.createdArtifactId }
            : {}),
        });
      });
      const provided = withAppLayer(root, programEff) as unknown as Effect.Effect<
        CliEvent,
        unknown,
        never
      >;
      const event = await runEffect(provided, "verify pass");
      if (getOutputMode() === "json") {
        emit("json", "verification.pass", { event });
        return;
      }
      printEvent(event);
    });

  // ---------------------------------------------------------------
  // `cognit verify fail <vid>`
  // ---------------------------------------------------------------
  verify
    .command("fail <vid>")
    .description("inject a verification_failed terminal event")
    .requiredOption("--stderr-excerpt <text>", "stderr excerpt (required)")
    .option("--exit-code <n>", "exit code")
    .option("--duration-ms <n>", "duration in ms")
    .option("--stdout-excerpt <text>", "stdout excerpt")
    .option("--created-artifact-id <id>", "artifact id (ULID)")
    .option("--session <id>", "session id (ULID)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root")
    .action(async (vid: string, opts: { stderrExcerpt: string } & VerifyOptions) => {
      const root = resolveProjectRoot(opts.root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const sessionId = requireSessionId(root, opts.session);
      const exitCode = parseOptionalInt(opts.exitCode, "--exit-code");
      const durationMs = parseOptionalInt(opts.durationMs, "--duration-ms");
      const programEff = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.failVerification({
          sessionId,
          verificationId: vid,
          actor,
          stderrExcerpt: opts.stderrExcerpt,
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(opts.stdoutExcerpt !== undefined ? { stdoutExcerpt: opts.stdoutExcerpt } : {}),
          ...(opts.createdArtifactId !== undefined
            ? { createdArtifactId: opts.createdArtifactId }
            : {}),
        });
      });
      const provided = withAppLayer(root, programEff) as unknown as Effect.Effect<
        CliEvent,
        unknown,
        never
      >;
      const event = await runEffect(provided, "verify fail");
      if (getOutputMode() === "json") {
        emit("json", "verification.fail", { event });
        return;
      }
      printEvent(event);
    });

  // ---------------------------------------------------------------
  // `cognit verify error <vid>`
  // ---------------------------------------------------------------
  verify
    .command("error <vid>")
    .description("inject a verification_errored terminal event")
    .requiredOption("--error <text>", "human-readable error message")
    .option("--error-code <code>", "typed error code (enoent|eacces|eperm|other)")
    .option("--duration-ms <n>", "duration in ms")
    .option("--session <id>", "session id (ULID)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root")
    .action(async (vid: string, opts: { error: string } & VerifyOptions) => {
      const root = resolveProjectRoot(opts.root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const sessionId = requireSessionId(root, opts.session);
      const durationMs = parseOptionalInt(opts.durationMs, "--duration-ms");
      const programEff = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.errorVerification({
          sessionId,
          verificationId: vid,
          actor,
          error: opts.error,
          ...(opts.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        });
      });
      const provided = withAppLayer(root, programEff) as unknown as Effect.Effect<
        CliEvent,
        unknown,
        never
      >;
      const event = await runEffect(provided, "verify error");
      if (getOutputMode() === "json") {
        emit("json", "verification.error", { event });
        return;
      }
      printEvent(event);
    });

  // ---------------------------------------------------------------
  // `cognit verify rerun <parent-vid>`
  // ---------------------------------------------------------------
  verify
    .command("rerun <parent-vid>")
    .description("chain a fresh verification_rerun from a terminal verification")
    .option("--duration-ms <n>", "duration in ms")
    .option("--session <id>", "session id (ULID)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root")
    .action(async (parentVid: string, opts: VerifyOptions) => {
      const root = resolveProjectRoot(opts.root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const sessionId = requireSessionId(root, opts.session);
      const durationMs = parseOptionalInt(opts.durationMs, "--duration-ms");
      const programEff = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.rerunVerification({
          sessionId,
          parentVerificationId: parentVid,
          actor,
          ...(durationMs !== undefined ? { durationMs } : {}),
        });
      });
      const provided = withAppLayer(root, programEff) as unknown as Effect.Effect<
        CliEvent,
        unknown,
        never
      >;
      const event = await runEffect(provided, "verify rerun");
      if (getOutputMode() === "json") {
        emit("json", "verification.rerun", { event });
        return;
      }
      printEvent(event);
    });
}
