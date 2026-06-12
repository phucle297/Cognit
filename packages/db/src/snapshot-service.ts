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
  readonly write: (
    input: SnapshotWriteInput,
  ) => Effect.Effect<SnapshotRow, DbError>;
  readonly latestForSession: (
    sessionId: string,
  ) => Effect.Effect<SnapshotRow | null, DbError>;
  readonly takeIfDue: (
    input: SnapshotTakeIfDueInput,
  ) => Effect.Effect<SnapshotRow | null, DbError>;
  /** Lower-level: just write a row, used by tests. */
  readonly _writeRaw: (row: Omit<SnapshotRow, "created_at"> & {
    created_at: string;
  }) => Effect.Effect<SnapshotRow, DbError>;
}

export class SnapshotService extends Context.Tag("@cognit/db/SnapshotService")<
  SnapshotService,
  SnapshotServiceShape
>() {}

const nowIso = (): string => new Date().toISOString();

/**
 * Serialize a SessionState to a deterministic JSON string. Object keys
 * are sorted at every nesting level so two snapshots of the same state
 * produce byte-equal output. This keeps snapshot dedup trivial.
 */
const serializeState = (state: SessionState): string => {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = sortKeys(obj[k]);
      }
      return sorted;
    }
    return v;
  };
  return JSON.stringify(sortKeys(state));
};

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
              [row.id, row.session_id, row.event_id, row.state_json, row.event_count, row.created_at],
            ),
          (e) => new DbError({ message: "snapshot: write", cause: e }),
        );
        yield* trySync(
          () =>
            conn.handle.run(
              "UPDATE sessions SET last_snapshot_event_id = ? WHERE id = ?",
              [row.event_id, row.session_id],
            ),
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
            state_json: serializeState(input.state),
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
          // Read all events, build state, write snapshot at the latest event.
          const events = yield* trySync(
            () =>
              conn.handle.all<EventRow>(
                "SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC",
                [input.sessionId],
              ),
            (e) => new DbError({ message: "snapshot takeIfDue: list events", cause: e }),
          );
          if (events.length === 0) return null;
          const state = input.build(events);
          const lastEvent = events[events.length - 1];
          if (!lastEvent) return null;
          const id = yield* uuid.make();
          const createdAt = nowIso();
          return yield* writeRaw({
            id,
            session_id: input.sessionId,
            event_id: lastEvent.id,
            state_json: serializeState(state),
            event_count: events.length,
            created_at: createdAt,
          });
        }),
    };
  }),
);
