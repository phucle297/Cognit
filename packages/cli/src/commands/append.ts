import fs from "node:fs";
import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import {
  EventStore,
  type ActorType,
} from "@cognit/db";
import { findProjectRoot } from "../paths.js";
import { withAppLayer } from "../layer-build.js";

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
    process.stderr.write(
      `cognit: --actor type must be one of human|worker|system, got: ${type}\n`,
    );
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
  eff: Effect.Effect<{ id: string; type: string; sessionId: string }, unknown, never>,
): Promise<{ id: string; type: string; sessionId: string }> => {
  const exit = await Effect.runPromiseExit(eff);
  if (Exit.isFailure(exit)) {
    const err = Cause.failureOption(exit.cause);
    if (err._tag === "Some") {
      const fail = err.value as { _tag?: string; type?: string; sessionId?: string; issues?: string; message?: string };
      switch (fail._tag) {
        case "UnknownEventType":
          process.stderr.write(
            `cognit: --type "${fail.type}" is not a known event type\n`,
          );
          break;
        case "UnknownSession":
          process.stderr.write(
            `cognit: --session "${fail.sessionId}" does not exist\n`,
          );
          break;
        case "ValidationFailure":
          process.stderr.write(
            `cognit: --type "${fail.type}" payload failed schema validation: ${fail.issues}\n`,
          );
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
    .requiredOption("--session <id>", "session id (ULID)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .action(async (opts: AppendOptions) => {
      const root = requireProjectRoot();
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const payload = resolvePayload(opts.payload);
      const eventType = opts.type!;
      const sessionId = opts.session!;

      const result = await runAppend(
        withAppLayer(
          root,
          Effect.gen(function* () {
            const store = yield* EventStore;
            const row = yield* store.append({
              type: eventType,
              payload,
              sessionId,
              actor,
            });
            return { id: row.id, type: row.type, sessionId: row.session_id };
          }),
        ),
      );
      process.stdout.write(`event:    ${result.id}\n`);
      process.stdout.write(`type:     ${result.type}\n`);
      process.stdout.write(`session:  ${result.sessionId}\n`);
    });
}
