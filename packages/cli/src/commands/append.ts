import fs from "node:fs";
import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { SessionService, type ActorType } from "@cognit/db";
import { findProjectRoot } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayerAndConfig } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";

interface AppendOptions {
  type?: string;
  payload?: string;
  session?: string;
  actor?: string;
}

const VALID_ACTOR_TYPES: ReadonlySet<ActorType> = new Set<ActorType>(["human", "worker", "system"]);

/** Parse an `--actor "name:type"` string, falling back to the supplied defaults. */
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
 * Resolve `--payload` into a parsed JSON value. The flag accepts:
 *   - inline JSON starting with `{` or `[` (or any JSON)
 *   - a path to a `.json` file
 *
 * Inline JSON is detected by checking the first non-whitespace
 * character. If it starts with `{` or `[`, parse directly; otherwise
 * treat the value as a file path. Files that don't exist fail with a
 * clean error.
 */
const resolvePayload = (raw: string | undefined): unknown => {
  if (raw === undefined) return {};
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`cognit: --payload is not valid JSON: ${(e as Error).message}\n`);
      process.exitCode = 2;
      throw new Error("--payload: invalid JSON");
    }
  }
  // Treat as a file path.
  if (!fs.existsSync(raw)) {
    process.stderr.write(`cognit: --payload file not found: ${raw}\n`);
    process.exitCode = 2;
    throw new Error("--payload: file not found");
  }
  let text: string;
  try {
    text = fs.readFileSync(raw, "utf8");
  } catch (e) {
    process.stderr.write(`cognit: --payload could not read ${raw}: ${(e as Error).message}\n`);
    process.exitCode = 2;
    throw new Error("--payload: read failed");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    process.stderr.write(
      `cognit: --payload file ${raw} is not valid JSON: ${(e as Error).message}\n`,
    );
    process.exitCode = 2;
    throw new Error("--payload: invalid JSON");
  }
};

const requireProjectRoot = (): string => {
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write("cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n");
    process.exitCode = 2;
    throw new Error("not in a cognit project");
  }
  return root;
};

const runAppend = async (
  eff: Effect.Effect<
    { event: { id: string; type: string; session_id: string }; snapshotTaken: boolean },
    unknown,
    never
  >,
): Promise<{ event: { id: string; type: string; session_id: string }; snapshotTaken: boolean }> => {
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
            `cognit: --type "${fail.type}" payload failed schema validation: ${fail.issues}\n`,
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
        process.stderr.write(`cognit: append failed\n`);
      }
    }
    if (process.exitCode === undefined) process.exitCode = 1;
    throw new Error("append: failed");
  }
  return exit.value;
};

/**
 * `cognit append --type <T> --payload <json|file> --session <id> [--actor name:type]`
 *
 * Append a single event to the active session. Payload may be inline
 * JSON or a path to a `.json` file. Actor defaults to
 * `cognit-cli:system`.
 */
export function registerAppend(program: Command): void {
  program
    .command("append")
    .description("append a single event to a session")
    .requiredOption("--type <type>", "event type (e.g. observation_recorded)")
    .option("--payload <json|file>", 'event payload (inline JSON or .json file). Default: "{}"')
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .action(async (opts: AppendOptions) => {
      const root = requireProjectRoot();
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const payload = resolvePayload(opts.payload);
      const eventType = opts.type!;
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
        const sessions = yield* SessionService;
        const result = yield* sessions.appendEvent({
          type: eventType,
          payload,
          sessionId,
          actor,
        });
        return { event: result.event, snapshotTaken: result.snapshotTaken };
      });
      // withAppLayerAndConfig reads cognit.yaml once and threads the
      // derived SessionPolicy into the app layer; this is the path
      // that triggers auto-snapshot when everyN events accumulate.
      const provided = await withAppLayerAndConfig(root, program);
      const result = await runAppend(provided);
      if (getOutputMode() === "json") {
        emit("json", "append", {
          event: result.event,
          snapshotTaken: result.snapshotTaken,
        });
        return;
      }
      process.stdout.write(`event:    ${result.event.id}\n`);
      process.stdout.write(`type:     ${result.event.type}\n`);
      process.stdout.write(`session:  ${result.event.session_id}\n`);
      process.stdout.write(`snapshot: ${result.snapshotTaken ? "yes" : "no"}\n`);
    });
}
