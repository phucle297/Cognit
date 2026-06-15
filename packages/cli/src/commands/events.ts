import { Command } from "commander";
import { Effect } from "effect";
import { EventStore, type EventRow } from "@cognit/db";
import { findProjectRoot } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayer } from "../layer-build.js";
import { emit, getOutputMode, type OutputMode } from "../output.js";

interface EventsOptions {
  session?: string;
  type?: string;
  follow?: boolean;
  json?: boolean;
}

const requireProjectRoot = (): string => {
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write("cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n");
    process.exitCode = 2;
    throw new Error("not in a cognit project");
  }
  return root;
};

/**
 * Render a list of events as a fixed-width text table. Three columns:
 * `id`, `type`, `created_at`. Matches the style of other CLI commands
 * (no fancy alignment — spaces are fine for the local-first audience).
 */
const renderTextTable = (events: ReadonlyArray<EventRow>): string => {
  const idW = Math.max(2, ...events.map((e) => e.id.length));
  const typeW = Math.max(4, ...events.map((e) => e.type.length));
  const lines: string[] = [];
  lines.push(`${"id".padEnd(idW)}  ${"type".padEnd(typeW)}  created_at`);
  lines.push(`${"-".repeat(idW)}  ${"-".repeat(typeW)}  ----------`);
  for (const e of events) {
    lines.push(`${e.id.padEnd(idW)}  ${e.type.padEnd(typeW)}  ${e.created_at}`);
  }
  return lines.join("\n") + (events.length > 0 ? "\n" : "");
};

const runEventsCommand = <A, E, R>(
  root: string,
  eff: Effect.Effect<A, E, R>,
): Promise<A> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provided = withAppLayer(root, eff) as any as Effect.Effect<A, E, never>;
  return Effect.runPromise(provided).catch((e: unknown) => {
    if (process.exitCode === undefined) process.exitCode = 1;
    process.stderr.write(`cognit: ${(e as Error).message ?? String(e)}\n`);
    throw e;
  });
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `cognit events [--session <id>] [--type <T>] [--follow] [--json]`
 *
 * List events for a session. Without `--follow`, prints all events
 * (up to the EventStore's default 100-row limit) and exits. With
 * `--follow`, polls the store every 1s and emits any new events it
 * finds; existing events are flushed first, then new ones stream
 * inline. The `--type` flag filters by event type on both paths.
 *
 * `--json` switches the output to the stable v1 envelope:
 *   - list mode:    kind `events.list`  → data: { events, count }
 *   - follow mode:  kind `events.follow` per-batch
 */
export function registerEvents(program: Command): void {
  program
    .command("events")
    .description("list events for a session (optionally follow new events)")
    .option("--session <id>", "session id (ULID). Defaults to the sticky current-session pointer.")
    .option("--type <event-type>", "filter to a single event type (e.g. observation_recorded)")
    .option("--follow", "poll every 1s and emit new events as they appear")
    .option("--json", "emit a stable JSON envelope on stdout")
    .action(async (opts: EventsOptions) => {
      const root = requireProjectRoot();
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
      const type = opts.type;
      // The local `--json` flag takes precedence over the global one,
      // but in practice the global hook has already set the mode.
      const mode: OutputMode = opts.json || getOutputMode() === "json" ? "json" : "text";

      if (!opts.follow) {
        // One-shot list. Read once and print.
        const events = await runEventsCommand(
          root,
          Effect.gen(function* () {
            const store = yield* EventStore;
            const result = yield* store.list({
              sessionId,
              ...(type !== undefined ? { type } : {}),
            });
            return result.events;
          }),
        );
        if (mode === "text") {
          process.stdout.write(renderTextTable(events));
          return;
        }
        emit(mode, "events.list", { events, count: events.length });
        return;
      }

      // Follow mode. First emit the existing events (with no cursor),
      // then poll for new ones using `afterEventId` to advance.
      let lastSeenId: string | undefined = undefined;
      // Initial flush.
      const initial = await runEventsCommand(
        root,
        Effect.gen(function* () {
          const store = yield* EventStore;
          const result = yield* store.list({
            sessionId,
            ...(type !== undefined ? { type } : {}),
            ...(lastSeenId !== undefined ? { afterEventId: lastSeenId } : {}),
          });
          return result.events;
        }),
      );
      if (initial.length > 0) {
        lastSeenId = initial[initial.length - 1]?.id ?? lastSeenId;
        if (mode === "text") {
          process.stdout.write(renderTextTable(initial));
        } else {
          emit(mode, "events.follow", { events: initial, count: initial.length });
        }
      }
      // Poll loop. 1s cadence; exit cleanly on SIGINT via the runtime.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await sleep(1000);
        const batch = await runEventsCommand(
          root,
          Effect.gen(function* () {
            const store = yield* EventStore;
            const result = yield* store.list({
              sessionId,
              ...(type !== undefined ? { type } : {}),
              ...(lastSeenId !== undefined ? { afterEventId: lastSeenId } : {}),
            });
            return result.events;
          }),
        );
        if (batch.length === 0) continue;
        lastSeenId = batch[batch.length - 1]?.id ?? lastSeenId;
        if (mode === "text") {
          process.stdout.write(renderTextTable(batch));
        } else {
          emit(mode, "events.follow", { events: batch, count: batch.length });
        }
      }
    });
}
