import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { CognitionService, type ActorType, type VerificationType } from "@cognit/db";
import { findProjectRoot } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayer } from "../layer-build.js";

interface VerifyStartOptions {
  session?: string;
  type?: string;
  actor?: string;
  root?: string;
  linkedHypothesis?: string;
  parentVerification?: string;
  id?: string;
  reason?: string;
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

const runEffect = async (
  eff: Effect.Effect<
    { id: string; type: string; session_id: string; created_at: string },
    unknown,
    never
  >,
  label: string,
): Promise<{ id: string; type: string; session_id: string; created_at: string }> => {
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

const printEvent = (event: {
  id: string;
  type: string;
  session_id: string;
  created_at: string;
}): void => {
  process.stdout.write(`event:    ${event.id}\n`);
  process.stdout.write(`type:     ${event.type}\n`);
  process.stdout.write(`session:  ${event.session_id}\n`);
  process.stdout.write(`time:     ${event.created_at}\n`);
};

/**
 * `cognit verify "command" --type <test|lint|build|exec|typecheck> --session <id> [--linked-hypothesis <id>]`
 * `cognit verify cancel --id <vid> --reason "..." --session <id>`
 *
 * Both subcommands live under the same `verify` parent command per
 * plan.xml:421. Start emits `verification_started`; cancel emits
 * `verification_cancelled`. The `start` flow takes a positional
 * `<command>` argument, so it is the *default* action of the
 * `verify` command: `cognit verify <cmd> ...` runs start, while
 * `cognit verify cancel ...` dispatches to cancel. This avoids the
 * commander quirk where a subcommand with a positional collides
 * with explicit subcommands.
 */
export function registerVerification(program: Command): void {
  program
    .command("verify")
    .description(
      "verification lifecycle: start (verification_started) / cancel (verification_cancelled)",
    )
    .option("--type <kind>", "verification type: test|lint|build|exec|typecheck")
    .option("--session <id>", "session id (ULID)")
    .option("--linked-hypothesis <id>", "hypothesis id (ULID) this verification checks")
    .option("--parent-verification <id>", "parent verification id (for rerun chains)")
    .option("--id <verificationId>", "verification id (ULID) [for cancel]")
    .option("--reason <text>", "cancellation reason [for cancel]")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .argument("[command]", "the command to run (e.g. `pnpm test`) — start mode")
    .allowExcessArguments(false)
    .action(async (command: string | undefined, opts: VerifyStartOptions) => {
      // Dispatch: if the first positional is "cancel", or if a --id
      // without a <command> is given, treat as cancel. Otherwise
      // start.
      const isCancel = command === "cancel" || (command === undefined && opts.id !== undefined);
      if (isCancel) {
        const root = resolveProjectRoot(opts.root);
        const actor = parseActor(opts.actor, "cognit-cli", "system");
      const resolved = resolveSessionId(root, opts.session);
      if (!resolved) {
        process.stderr.write(
          "cognit: --session is required (or run `cognit session create` to set the sticky pointer)\n",
        );
        process.exitCode = 2;
        return;
      }
      if (resolved.source === "pointer") warnStalePointer(root, resolved.sessionId);
      const sessionId = resolved.sessionId;
        const verificationId = opts.id;
        const reason = opts.reason;
        if (!sessionId || !verificationId || !reason) {
          process.stderr.write("cognit: verify cancel requires --id, --reason, and --session\n");
          process.exitCode = 2;
          throw new Error("verify cancel: missing required flags");
        }

        const program = Effect.gen(function* () {
          const cognition = yield* CognitionService;
          return yield* cognition.cancelVerification({
            sessionId,
            verificationId,
            reason,
            actor,
          });
        });
        const provided = await withAppLayer(root, program);
        const event = await runEffect(provided, "verify cancel");
        printEvent(event);
        return;
      }

      if (!command) {
        process.stderr.write(
          "cognit: verify requires a <command> positional (e.g. `pnpm test`); for cancel, use `cognit verify cancel --id <vid> --reason <text> --session <sid>`\n",
        );
        process.exitCode = 2;
        throw new Error("verify: missing command");
      }
      const root = resolveProjectRoot(opts.root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const type = parseVerificationType(opts.type);
      const resolved = resolveSessionId(root, opts.session);
      if (!resolved) {
        process.stderr.write(
          "cognit: --session is required (or run `cognit session create` to set the sticky pointer)\n",
        );
        process.exitCode = 2;
        return;
      }
      if (resolved.source === "pointer") warnStalePointer(root, resolved.sessionId);
      const sessionId = resolved.sessionId;
      if (!sessionId) {
        process.stderr.write("cognit: --session is required\n");
        process.exitCode = 2;
        throw new Error("--session: missing");
      }

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.verify({
          sessionId,
          command,
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
      const provided = await withAppLayer(root, program);
      const event = await runEffect(provided, "verify");
      printEvent(event);
    });
}
