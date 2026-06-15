import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { CognitionService, type ActorType } from "@cognit/db";
import { findProjectRoot } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayer } from "../layer-build.js";

interface AddEdgeOptions {
  session?: string;
  fromType?: string;
  fromId?: string;
  toType?: string;
  toId?: string;
  kind?: string;
  actor?: string;
  root?: string;
}

interface ListEdgeOptions {
  session?: string;
  root?: string;
}

const VALID_ACTOR_TYPES: ReadonlySet<ActorType> = new Set<ActorType>(["human", "worker", "system"]);

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

/**
 * Pretty-print a known `SessionError` failure tag. Mirror of the
 * `runObserve` helper in `observation.ts` — same chokepoint, same
 * failure modes.
 */
const printFailure = (fail: {
  _tag?: string;
  type?: string;
  sessionId?: string;
  issues?: string;
  message?: string;
}): void => {
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
      process.stderr.write(`cognit: edge payload failed schema validation: ${fail.issues}\n`);
      break;
    case "DbError":
      process.stderr.write(`cognit: ${fail.message ?? String(fail)}\n`);
      break;
    default:
      process.stderr.write(`cognit: ${fail.message ?? String(fail)}\n`);
  }
};

const runEdge = async (
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
      printFailure(err.value as Parameters<typeof printFailure>[0]);
    } else {
      const die = Cause.dieOption(exit.cause);
      if (die._tag === "Some") {
        process.stderr.write(`cognit: ${String(die.value)}\n`);
      } else {
        process.stderr.write(`cognit: edge failed\n`);
      }
    }
    if (process.exitCode === undefined) process.exitCode = 1;
    throw new Error("edge: failed");
  }
  return exit.value;
};

const runList = async <A>(
  eff: Effect.Effect<A, unknown, never>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(eff);
  if (Exit.isFailure(exit)) {
    const err = Cause.failureOption(exit.cause);
    if (err._tag === "Some") {
      printFailure(err.value as Parameters<typeof printFailure>[0]);
    } else {
      const die = Cause.dieOption(exit.cause);
      if (die._tag === "Some") {
        process.stderr.write(`cognit: ${String(die.value)}\n`);
      } else {
        process.stderr.write(`cognit: edge list failed\n`);
      }
    }
    if (process.exitCode === undefined) process.exitCode = 1;
    throw new Error("edge list: failed");
  }
  return exit.value;
};

interface EdgeRow {
  readonly edgeType: string;
  readonly fromEntityType: string;
  readonly fromEntityId: string;
  readonly toEntityType: string;
  readonly toEntityId: string;
  readonly eventId: string;
  readonly createdAt: string;
}

const printEdges = (rows: ReadonlyArray<EdgeRow>): void => {
  if (rows.length === 0) {
    process.stdout.write("(no edges)\n");
    return;
  }
  // Pad each column to the widest cell in that column so the table
  // stays readable across arbitrary entity-type / id widths.
  const header = ["#", "KIND", "FROM", "->", "TO", "EVENT", "CREATED_AT"];
  const body = rows.map((r, i) => {
    const from = `${r.fromEntityType}:${r.fromEntityId}`;
    const to = `${r.toEntityType}:${r.toEntityId}`;
    return [
      String(i + 1),
      r.edgeType,
      from,
      "->",
      to,
      r.eventId,
      r.createdAt,
    ];
  });
  const cols = header.map((h, idx) => {
    const widest = body.reduce((w, row) => Math.max(w, row[idx]!.length), h.length);
    return widest;
  });
  const fmt = (cells: ReadonlyArray<string>): string =>
    cells.map((c, i) => c.padEnd(cols[i]!)).join("  ");
  process.stdout.write(`${fmt(header)}\n`);
  for (const row of body) {
    process.stdout.write(`${fmt(row)}\n`);
  }
};

/**
 * `cognit edge add --from-type <t> --from-id <id> --to-type <t> --to-id <id>
 *                 --kind <edge_type> --session <id> [--actor <name:type>]`
 *
 * First-class subcommand for the `edge_created` event. The payload is
 * the 5 string fields per `EdgeCreatedPayload` (`edge_type`,
 * `from_entity_type`, `from_entity_id`, `to_entity_type`,
 * `to_entity_id`). Routes through `CognitionService.addEdge` →
 * `SessionService.appendEvent`.
 */
export function registerEdge(program: Command): void {
  const cmd = program
    .command("edge")
    .description("add or list edges between entities in a session (edge_created events)");

  cmd
    .command("add")
    .description("add a typed edge between two entities on a session (edge_created event)")
    .requiredOption("--from-type <type>", 'source entity type (e.g. "conclusion")')
    .requiredOption("--from-id <id>", "source entity id (ULID)")
    .requiredOption("--to-type <type>", 'target entity type (e.g. "decision")')
    .requiredOption("--to-id <id>", "target entity id (ULID)")
    .requiredOption("--kind <edge_type>", 'edge kind (e.g. "supports", "contradicts", "belongs_to")')
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: AddEdgeOptions) => {
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

      const program = Effect.gen(function* () {
        const cognition = yield* CognitionService;
        return yield* cognition.addEdge({
          sessionId,
          edgeType: opts.kind!,
          fromEntityType: opts.fromType!,
          fromEntityId: opts.fromId!,
          toEntityType: opts.toType!,
          toEntityId: opts.toId!,
          actor,
        });
      });
      const provided = await withAppLayer(root, program);
      const event = await runEdge(provided);
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
      process.stdout.write(
        `edge:     ${opts.fromType}:${opts.fromId} --${opts.kind}--> ${opts.toType}:${opts.toId}\n`,
      );
    });

  cmd
    .command("list")
    .description("list edges currently in a session's reduced state")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: ListEdgeOptions) => {
      const root = resolveProjectRoot(opts.root);
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
        return yield* cognition.listEdges({ sessionId });
      });
      const provided = await withAppLayer(root, program);
      const rows = await runList<ReadonlyArray<EdgeRow>>(provided);
      printEdges(rows);
    });
}
