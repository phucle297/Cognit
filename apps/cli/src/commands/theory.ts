import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { CognitionService, type ActorType } from "@cognit/db";
import { VALID_ACTOR_TYPES } from "@cognit/core";
import { findProjectRoot } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";
import { warnExperimentalOnce } from "./_deprecation.js";

interface TheoryOptions {
  session?: string;
  actor?: string;
  root?: string;
  id?: string;
  text?: string;
  into?: string;
}

/** Parse an `--actor "name:type"` string, falling back to defaults. */
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

/**
 * Resolve the project root. Accepts an explicit `--root` (used for
 * testing and for running outside a project tree) or falls back to
 * `findProjectRoot()` (walks up to find `.cognit/cognit.yaml`).
 */
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

const runTheory = async (
  eff: Effect.Effect<
    { id: string; type: string; session_id: string; created_at: string },
    unknown,
    never
  >,
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
            `cognit: theory payload failed schema validation: ${fail.issues}\n`,
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
        process.stderr.write(`cognit: theory failed\n`);
      }
    }
    if (process.exitCode === undefined) process.exitCode = 1;
    throw new Error("theory: failed");
  }
  return exit.value;
};

/**
 * `cognit theory ...` — subcommands for the theory lifecycle
 * (`theory_created`, `theory_updated`, `theory_merged`,
 * `theory_archived`). Each subcommand routes through
 * `CognitionService` → `SessionService.appendEvent` (the
 * constraint chokepoint that phase 3c will hook into).
 */
export function registerTheory(program: Command): void {
  const theory = program
    .command("theory")
    .description("theory lifecycle (theory_created, theory_updated, theory_merged, theory_archived)");

  theory
    .command("add")
    .description("add a new theory (theory_created event)")
    .argument("<title>", "theory title")
    .requiredOption("--text <text>", "theory body text")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (title: string, opts: TheoryOptions) => {
      warnExperimentalOnce("cognit theory");
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
      const text = opts.text!;

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.addTheory({
          sessionId,
          title,
          text,
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runTheory(provided);
      if (getOutputMode() === "json") {
        emit("json", "theory.add", { event });
        return;
      }
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });

  theory
    .command("update")
    .description("update an existing theory's body (theory_updated event)")
    .requiredOption("--id <id>", "theory id (ULID)")
    .requiredOption("--text <text>", "new theory body text")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: TheoryOptions) => {
      warnExperimentalOnce("cognit theory");
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
      const theoryId = opts.id!;
      const text = opts.text!;

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.updateTheory({
          sessionId,
          theoryId,
          text,
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runTheory(provided);
      if (getOutputMode() === "json") {
        emit("json", "theory.update", { event });
        return;
      }
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });

  theory
    .command("merge")
    .description("merge a theory into another (theory_merged event)")
    .requiredOption("--id <id>", "theory id (ULID) to merge from")
    .requiredOption("--into <id>", "target theory id (ULID) to merge into")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: TheoryOptions) => {
      warnExperimentalOnce("cognit theory");
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
      const theoryId = opts.id!;
      const mergedIntoTheoryId = opts.into!;

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.mergeTheory({
          sessionId,
          theoryId,
          mergedIntoTheoryId,
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runTheory(provided);
      if (getOutputMode() === "json") {
        emit("json", "theory.merge", { event });
        return;
      }
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });

  theory
    .command("archive")
    .description("archive a theory (theory_archived event)")
    .requiredOption("--id <id>", "theory id (ULID) to archive")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: TheoryOptions) => {
      warnExperimentalOnce("cognit theory");
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
      const theoryId = opts.id!;

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.archiveTheory({
          sessionId,
          theoryId,
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runTheory(provided);
      if (getOutputMode() === "json") {
        emit("json", "theory.archive", { event });
        return;
      }
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });
}
