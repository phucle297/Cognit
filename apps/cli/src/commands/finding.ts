import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { CognitionService, type ActorType } from "@cognit/db";
import { findProjectRoot } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";

interface FindingOptions {
  session?: string;
  related?: string;
  actor?: string;
  root?: string;
  confidence?: string;
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

/** Parse a `--confidence 0..1` string into a number, or fail. */
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

/** Parse `--related "id1,id2,id3"` into an array of trimmed ids. */
const parseRelated = (raw: string | undefined): ReadonlyArray<string> => {
  if (raw === undefined || raw.length === 0) return [];
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

const runFinding = async (
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
            `cognit: finding payload failed schema validation: ${fail.issues}\n`,
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
        process.stderr.write(`cognit: finding failed\n`);
      }
    }
    if (process.exitCode === undefined) process.exitCode = 1;
    throw new Error("finding: failed");
  }
  return exit.value;
};

/**
 * `cognit finding "text" --session <id> [--related <id1,id2,...>] [--actor name:type] [--root <p>] [--confidence <0..1>]`
 *
 * First-class subcommand for the `finding_created` event. The payload
 * is `{ text, related_observation_ids }` per `FindingCreatedPayload`;
 * `related_observation_ids` defaults to `[]` when `--related` is
 * omitted. The append routes through `CognitionService.recordFinding`
 * → `SessionService.appendEvent` (the constraint chokepoint that
 * phase 3c will hook into).
 */
export function registerFinding(program: Command): void {
  program
    .command("finding")
    .description("record a finding on a session (finding_created event)")
    .argument("<text>", "the finding text")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--related <ids>", "comma-separated observation ids this finding synthesizes")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .option("--confidence <0..1>", "confidence score in [0, 1]")
    .action(async (text: string, opts: FindingOptions) => {
      const root = resolveProjectRoot(opts.root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const confidence = parseConfidence(opts.confidence);
      const related = parseRelated(opts.related);
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
        return yield* cognition.recordFinding({
          sessionId,
          text,
          ...(related.length > 0 ? { relatedObservationIds: related } : {}),
          actor,
          ...(confidence !== undefined ? { confidence } : {}),
        });
      });
      // withAppLayer provides the full DbLive layer (which now
      // includes CognitionService on top of SessionService).
      const provided = await withAppLayer(root, program);
      const event = await runFinding(provided);
      if (getOutputMode() === "json") {
        emit("json", "finding.add", { event });
        return;
      }
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });
}
