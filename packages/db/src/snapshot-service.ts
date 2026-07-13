/**
 * SnapshotService — write, fetch, and policy-driven capture of session
 * state checkpoints.
 *
 * A snapshot row stores `state_json` (the full SessionState at that
 * point) and `event_id` (the last event applied). The reducer
 * (`@cognit/core/reducer`) is invoked by callers to build the state;
 * this service just persists the result and tracks the
 * `sessions.last_snapshot_event_id` pointer.
 *
 * Policy: `takeIfDue` writes a snapshot when the event count has
 * grown by `everyN` since the previous snapshot. Explicit callers
 * (session close, `cognit snapshot`) call `write` directly.
 *
 * The reducer lives in `@cognit/core`; the db layer imports it, never
 * the other way around. core stays I/O-free.
 */

import { Context, Effect, Layer } from "effect";
import { DbConnection, Logger } from "./context";
import { DbError, trySync } from "./errors";
import type { EventRow, SnapshotRow } from "./schema/rows";
import { Uuid } from "./ulid";
import type { SessionState } from "@cognit/core/state";
import { reduce } from "@cognit/core/reducer";
import { parseSnapshotStateJson, wrapSnapshotEnvelope } from "@cognit/core/serialize-state";

/**
 * Field names on `SessionState` that hold a `ReadonlyMap`. Shared
 * with session-service rehydrate.
 */
const MAP_FIELDS: ReadonlySet<string> = new Set([
  "hypotheses",
  "theories",
  "experiments",
  "decisions",
  "conclusions",
  "verifications",
  "artifacts",
]);

/** Convert JSON object form of Map fields back to Maps. */
export const rehydrateSessionState = (parsed: Record<string, unknown>): SessionState => {
  const out: Record<string, unknown> = { ...parsed };
  for (const k of MAP_FIELDS) {
    const v = out[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const m = new Map<string, unknown>();
      for (const [id, val] of Object.entries(v as Record<string, unknown>)) {
        m.set(id, val);
      }
      out[k] = m;
    } else {
      out[k] = new Map();
    }
  }
  // Slim snapshots store empty timeline; ensure array form.
  if (!Array.isArray(out["timeline"])) {
    out["timeline"] = [];
  }
  return out as unknown as SessionState;
};

type DbConnService = Context.Tag.Service<typeof DbConnection>;
type UuidService = Context.Tag.Service<typeof Uuid>;
type LoggerService = Context.Tag.Service<typeof Logger>;

export interface SnapshotWriteInput {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly eventId: string;
  readonly eventCount: number;
}

export interface SnapshotTakeIfDueInput {
  readonly sessionId: string;
  readonly currentEventCount: number;
  readonly everyN: number;
  /**
   * Reducer call: given a session id and the events to fold, return
   * the SessionState. Injected so this service can stay testable
   * without depending on the EventStore (which has its own R-channel).
   * The default caller (SessionService.close) supplies reduce().
   */
  readonly build: (events: ReadonlyArray<EventRow>) => SessionState;
}

export interface SnapshotServiceShape {
  readonly write: (input: SnapshotWriteInput) => Effect.Effect<SnapshotRow, DbError>;
  readonly latestForSession: (sessionId: string) => Effect.Effect<SnapshotRow | null, DbError>;
  readonly takeIfDue: (input: SnapshotTakeIfDueInput) => Effect.Effect<SnapshotRow | null, DbError>;
  /** Lower-level: just write a row, used by tests. */
  readonly _writeRaw: (
    row: Omit<SnapshotRow, "created_at"> & {
      created_at: string;
    },
  ) => Effect.Effect<SnapshotRow, DbError>;
}

export class SnapshotService extends Context.Tag("@cognit/db/SnapshotService")<
  SnapshotService,
  SnapshotServiceShape
>() {}

const nowIso = (): string => new Date().toISOString();

/**
 * Serialize SessionState into the versioned snapshot envelope
 * (D-M1-03) with a slim (empty) timeline (D-M1-02). Entity maps are
 * converted to plain objects via `wrapSnapshotEnvelope`.
 */
const serializeState = (state: SessionState, eventId: string): string =>
  wrapSnapshotEnvelope(
    {
      ...state,
      snapshot_event_id: eventId,
      timeline: [],
    },
    { slimTimeline: true },
  );

export const SnapshotServiceLive: Layer.Layer<
  SnapshotService,
  never,
  DbConnection | Uuid | Logger
> = Layer.effect(
  SnapshotService,
  Effect.gen(function* () {
    const conn: DbConnService = yield* DbConnection;
    const uuid: UuidService = yield* Uuid;
    const logger: LoggerService = yield* Logger;

    const writeRaw = (
      row: Omit<SnapshotRow, "created_at"> & { created_at: string },
    ): Effect.Effect<SnapshotRow, DbError> =>
      Effect.gen(function* () {
        yield* trySync(
          () =>
            conn.handle.run(
              `INSERT INTO snapshots (id, session_id, event_id, state_json, event_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [
                row.id,
                row.session_id,
                row.event_id,
                row.state_json,
                row.event_count,
                row.created_at,
              ],
            ),
          (e) => new DbError({ message: "snapshot: write", cause: e }),
        );
        yield* trySync(
          () =>
            conn.handle.run("UPDATE sessions SET last_snapshot_event_id = ? WHERE id = ?", [
              row.event_id,
              row.session_id,
            ]),
          (e) => new DbError({ message: "snapshot: update session", cause: e }),
        );
        yield* logger.log(
          "info",
          { snapshotId: row.id, sessionId: row.session_id, eventCount: row.event_count },
          "snapshot: written",
        );
        return row as SnapshotRow;
      });

    return {
      _writeRaw: writeRaw,

      write: (input) =>
        Effect.gen(function* () {
          const id = yield* uuid.make();
          const createdAt = nowIso();
          return yield* writeRaw({
            id,
            session_id: input.sessionId,
            event_id: input.eventId,
            state_json: serializeState(input.state, input.eventId),
            event_count: input.eventCount,
            created_at: createdAt,
          });
        }),

      latestForSession: (sessionId) =>
        Effect.sync(
          (): SnapshotRow | null =>
            conn.handle.get<SnapshotRow>(
              "SELECT * FROM snapshots WHERE session_id = ? ORDER BY event_count DESC, created_at DESC LIMIT 1",
              [sessionId],
            ) ?? null,
        ).pipe(Effect.mapError((e) => new DbError({ message: "snapshot: latest", cause: e }))),

      takeIfDue: (input) =>
        Effect.gen(function* () {
          const latest = yield* trySync(
            () =>
              conn.handle.get<SnapshotRow>(
                "SELECT * FROM snapshots WHERE session_id = ? ORDER BY event_count DESC, created_at DESC LIMIT 1",
                [input.sessionId],
              ),
            (e) => new DbError({ message: "snapshot takeIfDue: latest", cause: e }),
          );
          const lastCount = latest ? latest.event_count : 0;
          if (input.currentEventCount - lastCount < input.everyN) {
            return null;
          }

          // D-M1-02: when a prior snapshot exists and rehydrates cleanly,
          // load only the tail (`id > snapshot.event_id`) and fold onto
          // the base. Otherwise cold-build from the full event list via
          // the injected `build` callback.
          let state: SessionState;
          let lastEventId: string;
          let eventCount: number;

          if (latest) {
            const parsed = parseSnapshotStateJson(latest.state_json);
            const tail = yield* trySync(
              () =>
                conn.handle.all<EventRow>(
                  "SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY created_at ASC, id ASC",
                  [input.sessionId, latest.event_id],
                ),
              (e) => new DbError({ message: "snapshot takeIfDue: list tail events", cause: e }),
            );
            if (parsed) {
              const base = rehydrateSessionState(parsed.state);
              // Ensure snapshot_event_id is set so reduce skips correctly
              // if any pre-snapshot events sneak into the list.
              const initial: SessionState = {
                ...base,
                snapshot_event_id: base.snapshot_event_id ?? latest.event_id,
                timeline: base.timeline ?? [],
              };
              state = reduce(tail, initial);
              const lastTail = tail[tail.length - 1];
              lastEventId = lastTail?.id ?? latest.event_id;
              eventCount = latest.event_count + tail.length;
            } else {
              // Invalid/unsupported envelope → full rebuild.
              const allEvents = yield* trySync(
                () =>
                  conn.handle.all<EventRow>(
                    "SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC",
                    [input.sessionId],
                  ),
                (e) => new DbError({ message: "snapshot takeIfDue: list events", cause: e }),
              );
              if (allEvents.length === 0) return null;
              state = input.build(allEvents);
              const lastEvent = allEvents[allEvents.length - 1];
              if (!lastEvent) return null;
              lastEventId = lastEvent.id;
              eventCount = allEvents.length;
            }
          } else {
            const allEvents = yield* trySync(
              () =>
                conn.handle.all<EventRow>(
                  "SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC",
                  [input.sessionId],
                ),
              (e) => new DbError({ message: "snapshot takeIfDue: list events", cause: e }),
            );
            if (allEvents.length === 0) return null;
            state = input.build(allEvents);
            const lastEvent = allEvents[allEvents.length - 1];
            if (!lastEvent) return null;
            lastEventId = lastEvent.id;
            eventCount = allEvents.length;
          }

          const id = yield* uuid.make();
          const createdAt = nowIso();
          return yield* writeRaw({
            id,
            session_id: input.sessionId,
            event_id: lastEventId,
            state_json: serializeState(state, lastEventId),
            event_count: eventCount,
            created_at: createdAt,
          });
        }),
    };
  }),
);
