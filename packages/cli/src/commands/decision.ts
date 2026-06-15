import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { CognitionService, type ActorType } from "@cognit/db";
import { findProjectRoot } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayer } from "../layer-build.js";

interface ProposeOptions {
  session?: string;
  actor?: string;
  root?: string;
  basedOn?: string;
  confidence?: string;
}

interface AcceptOptions {
  session?: string;
  actor?: string;
  root?: string;
  basedOn?: string;
  id?: string;
}

interface RejectOptions {
  session?: string;
  actor?: string;
  root?: string;
  reason?: string;
  id?: string;
}

interface SupersedeOptions {
  session?: string;
  actor?: string;
  root?: string;
  by?: string;
  id?: string;
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

/** Parse `--confidence 0..1` string into a number, or fail. */
const parseConfidence = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    process.stderr.write(`cognit: --confidence must be a number in [0, 1], got: ${raw}\n`);
    process.exitCode = 2;
    throw new Error("--confidence: out of range");
  }
  return n;
};

/** Parse `--based-on id,id,...` (or `id` repeated) into a string array. */
const parseBasedOn = (raw: string | undefined): string[] => {
  if (raw === undefined || raw === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

const runDecision = async (
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
            `cognit: decision payload failed schema validation: ${fail.issues}\n`,
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
        process.stderr.write(`cognit: decision failed\n`);
      }
    }
    if (process.exitCode === undefined) process.exitCode = 1;
    throw new Error("decision: failed");
  }
  return exit.value;
};

/**
 * `cognit decision {propose,accept,reject,supersede} ...`
 *
 * First-class CLI for the 4-state decision lifecycle. The payload for
 * each event is the typed shape from `DecisionProposedPayload`,
 * `DecisionAcceptedPayload`, `DecisionRejectedPayload`, or
 * `DecisionSupersededPayload`. The append routes through
 * `CognitionService.{proposeDecision,acceptDecision,rejectDecision,
 * supersedeDecision}` → `SessionService.appendEvent` (the constraint
 * chokepoint that phase 3c will hook into).
 */
export function registerDecision(program: Command): void {
  const cmd = program
    .command("decision")
    .description("manage decisions on a session (4-state lifecycle: propose, accept, reject, supersede)");

  cmd
    .command("propose")
    .description("propose a new decision (decision_proposed event)")
    .argument("<text>", "the decision text")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .requiredOption("--based-on <ids>", "comma-separated conclusion ids the decision is based on")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .option("--confidence <0..1>", "confidence score in [0, 1]")
    .action(async (text: string, opts: ProposeOptions) => {
      const root = resolveProjectRoot(opts.root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const confidence = parseConfidence(opts.confidence);
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
      const basedOnConclusionIds = parseBasedOn(opts.basedOn);

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.proposeDecision({
          sessionId,
          text,
          basedOnConclusionIds,
          actor,
          ...(confidence !== undefined ? { confidence } : {}),
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runDecision(provided);
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });

  cmd
    .command("accept")
    .description("accept a proposed decision (decision_accepted event)")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .requiredOption("--id <id>", "decision id being accepted")
    .requiredOption("--based-on <ids>", "comma-separated conclusion ids the decision is based on")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: AcceptOptions) => {
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
      const decisionId = opts.id!;
      const basedOnConclusionIds = parseBasedOn(opts.basedOn);

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.acceptDecision({
          sessionId,
          decisionId,
          basedOnConclusionIds,
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runDecision(provided);
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });

  cmd
    .command("reject")
    .description("reject a proposed decision (decision_rejected event)")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .requiredOption("--id <id>", "decision id being rejected")
    .requiredOption("--reason <text>", "reason for rejecting the decision")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: RejectOptions) => {
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
      const decisionId = opts.id!;
      const reason = opts.reason!;

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.rejectDecision({
          sessionId,
          decisionId,
          reason,
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runDecision(provided);
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });

  cmd
    .command("supersede")
    .description("supersede a decision with a new one (decision_superseded event)")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .requiredOption("--id <id>", "decision id being superseded")
    .requiredOption("--by <id>", "id of the new decision replacing it")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: SupersedeOptions) => {
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
      const decisionId = opts.id!;
      const supersededByDecisionId = opts.by!;

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.supersedeDecision({
          sessionId,
          decisionId,
          supersededByDecisionId,
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runDecision(provided);
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });
}
