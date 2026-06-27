import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { CognitionService, type ActorType } from "@cognit/db";
import { VALID_ACTOR_TYPES } from "@cognit/core";
import { findProjectRoot } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";

interface ConcludeOptions {
  session?: string;
  actor?: string;
  root?: string;
  confidence?: string;
}

interface VerifyConclusionOptions {
  session?: string;
  id?: string;
  verification?: string;
  evidence?: string;
  actor?: string;
  root?: string;
  confidence?: string;
}

interface RejectConclusionOptions {
  session?: string;
  id?: string;
  reason?: string;
  actor?: string;
  root?: string;
}

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

const parseCsv = (raw: string | undefined): ReadonlyArray<string> => {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
 * `cognit conclusion propose "text" --session <id> [--confidence <0..1>]`
 *
 * First-class subcommand for the `conclusion_proposed` event. Payload
 * is the single `text` field per `ConclusionProposedPayload`.
 */
export function registerConclusion(program: Command): void {
  const conclusion = program
    .command("conclusion")
    .description("conclusion lifecycle: propose / verify / reject");

  conclusion
    .command("propose")
    .description("propose a conclusion (conclusion_proposed event)")
    .argument("<text>", "the conclusion text")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .option("--confidence <0..1>", "confidence score in [0, 1]")
    .action(async (text: string, opts: ConcludeOptions) => {
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

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.proposeConclusion({
          sessionId,
          text,
          actor,
          ...(confidence !== undefined ? { confidence } : {}),
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runEffect(provided, "conclusion propose");
      if (getOutputMode() === "json") {
        emit("json", "conclusion.propose", { event });
        return;
      }
      printEvent(event);
    });

  conclusion
    .command("verify")
    .description("verify a conclusion (conclusion_verified event)")
    .requiredOption("--id <conclusionId>", "conclusion id (ULID)")
    .requiredOption("--verification <vid>", "verification id (ULID) backing this verification")
    .requiredOption("--evidence <id,id,...>", "comma-separated supporting evidence ids")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .option("--confidence <0..1>", "confidence score in [0, 1]")
    .action(async (opts: VerifyConclusionOptions) => {
      const root = resolveProjectRoot(opts.root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const confidence = parseConfidence(opts.confidence);
      const evidence = parseCsv(opts.evidence);
      if (evidence.length === 0) {
        process.stderr.write("cognit: --evidence must list at least one supporting evidence id\n");
        process.exitCode = 2;
        throw new Error("--evidence: empty");
      }
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
      const conclusionId = opts.id!;
      const verificationId = opts.verification!;

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.verifyConclusion({
          sessionId,
          conclusionId,
          verificationId,
          supportingEvidenceIds: evidence,
          actor,
          ...(confidence !== undefined ? { confidence } : {}),
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runEffect(provided, "conclusion verify");
      if (getOutputMode() === "json") {
        emit("json", "conclusion.verify", { event });
        return;
      }
      printEvent(event);
    });

  conclusion
    .command("reject")
    .description("reject a conclusion (conclusion_rejected event)")
    .requiredOption("--id <conclusionId>", "conclusion id (ULID)")
    .requiredOption("--reason <text>", "rejection reason")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: RejectConclusionOptions) => {
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
      const conclusionId = opts.id!;
      const reason = opts.reason!;

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.rejectConclusion({
          sessionId,
          conclusionId,
          reason,
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runEffect(provided, "conclusion reject");
      if (getOutputMode() === "json") {
        emit("json", "conclusion.reject", { event });
        return;
      }
      printEvent(event);
    });
}
