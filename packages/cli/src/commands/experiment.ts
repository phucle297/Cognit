import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { CognitionService, type ActorType } from "@cognit/db";
import { findProjectRoot } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";

interface ExperimentOptions {
  session?: string;
  actor?: string;
  root?: string;
  id?: string;
  design?: string;
  result?: string;
  supports?: string;
  contradicts?: string;
  testsHypothesis?: string;
}

const VALID_ACTOR_TYPES: ReadonlySet<ActorType> = new Set<ActorType>(["human", "worker", "system"]);

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
 * Parse a comma-separated list of ids (`--supports a,b,c`).
 * Returns `undefined` when the raw value is missing or empty
 * (the service defaults the payload field to `[]`).
 */
const parseIdList = (raw: string | undefined): ReadonlyArray<string> | undefined => {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 0 ? undefined : parts;
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

const runExperiment = async (
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
            `cognit: experiment payload failed schema validation: ${fail.issues}\n`,
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
        process.stderr.write(`cognit: experiment failed\n`);
      }
    }
    if (process.exitCode === undefined) process.exitCode = 1;
    throw new Error("experiment: failed");
  }
  return exit.value;
};

/**
 * `cognit experiment ...` — subcommands for the experiment lifecycle
 * (`experiment_created`, `experiment_completed`). Each subcommand
 * routes through `CognitionService` → `SessionService.appendEvent`
 * (the constraint chokepoint that phase 3c will hook into).
 */
export function registerExperiment(program: Command): void {
  const experiment = program
    .command("experiment")
    .description("experiment lifecycle (experiment_created, experiment_completed)");

  experiment
    .command("add")
    .description("add a new experiment (experiment_created event)")
    .requiredOption("--tests-hypothesis <id>", "hypothesis id (ULID) the experiment tests")
    .requiredOption("--design <text>", "experiment design")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: ExperimentOptions) => {
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
      const testsHypothesisId = opts.testsHypothesis!;
      const design = opts.design!;

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.addExperiment({
          sessionId,
          testsHypothesisId,
          design,
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runExperiment(provided);
      if (getOutputMode() === "json") {
        emit("json", "experiment.add", { event });
        return;
      }
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });

  experiment
    .command("complete")
    .description("complete an experiment (experiment_completed event)")
    .requiredOption("--id <id>", "experiment id (ULID) to complete")
    .requiredOption("--result <text>", "result summary")
    .option("--supports <ids>", "comma-separated list of hypothesis ids supported")
    .option("--contradicts <ids>", "comma-separated list of hypothesis ids contradicted")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: ExperimentOptions) => {
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
      const experimentId = opts.id!;
      const resultSummary = opts.result!;
      const supports = parseIdList(opts.supports);
      const contradicts = parseIdList(opts.contradicts);

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.completeExperiment({
          sessionId,
          experimentId,
          resultSummary,
          ...(supports !== undefined ? { supports } : {}),
          ...(contradicts !== undefined ? { contradicts } : {}),
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runExperiment(provided);
      if (getOutputMode() === "json") {
        emit("json", "experiment.complete", { event });
        return;
      }
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });
}
