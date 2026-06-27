import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { CognitionService, type ActorType, type ArtifactRole } from "@cognit/db";
import { VALID_ACTOR_TYPES } from "@cognit/core";
import { findProjectRoot } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";

interface ArtifactAddOptions {
  session?: string;
  id?: string;
  role?: string;
  actor?: string;
  root?: string;
}

const VALID_ROLES: ReadonlySet<ArtifactRole> = new Set<ArtifactRole>([
  "evidence",
  "code",
  "log",
  "config",
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

const parseRole = (raw: string | undefined): ArtifactRole => {
  if (!raw) {
    process.stderr.write("cognit: --role is required (evidence|code|log|config)\n");
    process.exitCode = 2;
    throw new Error("--role: missing");
  }
  if (!VALID_ROLES.has(raw as ArtifactRole)) {
    process.stderr.write(`cognit: --role must be one of evidence|code|log|config, got: ${raw}\n`);
    process.exitCode = 2;
    throw new Error("--role: invalid");
  }
  return raw as ArtifactRole;
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
 * `cognit artifact add --id <artifactId> --role <evidence|code|log|config> --session <id>`
 *
 * First-class subcommand for the `artifact_attached` event. Payload
 * is `{ artifact_id, role }` per `ArtifactAttachedPayload`.
 */
export function registerArtifact(program: Command): void {
  const artifact = program
    .command("artifact")
    .description("artifact lifecycle: add (artifact_attached)");

  artifact
    .command("add")
    .description("attach an artifact to the session (artifact_attached event)")
    .requiredOption("--id <artifactId>", "artifact id (ULID)")
    .requiredOption("--role <kind>", "artifact role: evidence|code|log|config")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: ArtifactAddOptions) => {
      const root = resolveProjectRoot(opts.root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const role = parseRole(opts.role);
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
      const artifactId = opts.id!;

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.attachArtifact({
          sessionId,
          artifactId,
          role,
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runEffect(provided, "artifact add");
      if (getOutputMode() === "json") {
        emit("json", "artifact.add", { event });
        return;
      }
      printEvent(event);
    });
}
