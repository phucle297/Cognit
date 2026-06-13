/**
 * SessionService — CRUD over the `sessions` table plus lifecycle events.
 *
 * The service has two responsibilities:
 *   1. Maintain the `sessions` row (insert, status transitions).
 *   2. Append the corresponding `session_created` / `session_paused` /
 *      `session_closed` events so the reducer and the event log stay
 *      in sync. Append is delegated to the existing `EventStore` —
 *      this service never inserts events directly.
 *
 * Bead 2c shipped create / list / getByGoalOrId / pause / close.
 * Bead 2e adds `resume` (fork or reopen) and `show` (reducer view).
 * Bead 2g wires the snapshot policy; `show` already supports the
 * snapshot+tail replay path (it looks up the latest snapshot row
 * directly) so the done_when for phase 2 is satisfied.
 */

import { Context, Effect, Layer } from "effect";
import { DbConnection, EventStore, Logger } from "./context";
import {
  DbError,
  UnknownEventType,
  UnknownSession,
  ValidationFailure,
  trySync,
} from "./errors";
import type { ActorType } from "./actor";
import type { EventRow, SessionRow, SnapshotRow } from "./schema/rows";
import { Uuid } from "./ulid";
import { reduce } from "@cognit/core/reducer";
import { emptySessionState, type SessionState } from "@cognit/core/state";
import { SnapshotService } from "./snapshot-service";

export type SessionError = DbError | UnknownEventType | ValidationFailure | UnknownSession;

type DbConnService = Context.Tag.Service<typeof DbConnection>;
type EventStoreService = Context.Tag.Service<typeof EventStore>;
type SnapshotServiceT = Context.Tag.Service<typeof SnapshotService>;
type UuidService = Context.Tag.Service<typeof Uuid>;
type LoggerService = Context.Tag.Service<typeof Logger>;

export type SessionLifecycleStatus = "active" | "paused" | "closed";

export interface SessionCreateInput {
  readonly projectId: string;
  readonly goal: string;
  readonly parentSessionId?: string | null;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface SessionListQuery {
  readonly projectId: string;
  readonly status?: SessionLifecycleStatus;
}

export interface GetByGoalOrIdInput {
  readonly projectId: string;
  readonly id?: string;
  readonly goal?: string;
  /**
   * When true (default) and multiple open sessions match the goal,
   * the most recently created one is picked. The matches list is
   * always returned so callers can warn or error as appropriate.
   */
  readonly preferMostRecent?: boolean;
}

export interface GetByGoalOrIdResult {
  readonly session: SessionRow;
  readonly matches: ReadonlyArray<SessionRow>;
  readonly ambiguous: boolean;
}

export interface SessionResumeInput {
  readonly projectId: string;
  /** id of the session to resume, or its goal. */
  readonly idOrGoal: string;
  /** When true (default), create a new session with parent_session_id. */
  readonly fork?: boolean;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface SessionShowResult {
  readonly session: SessionRow;
  readonly state: SessionState;
  readonly snapshot: SnapshotRow | null;
  /** When the snapshot+tail path is taken, the events applied after the snapshot. */
  readonly tail_event_count: number;
}

export interface SessionServiceShape {
  readonly create: (
    input: SessionCreateInput,
  ) => Effect.Effect<{ session: SessionRow; event: EventRow }, SessionError>;
  readonly list: (
    q: SessionListQuery,
  ) => Effect.Effect<ReadonlyArray<SessionRow>, DbError>;
  readonly getByGoalOrId: (
    input: GetByGoalOrIdInput,
  ) => Effect.Effect<
    GetByGoalOrIdResult,
    DbError | { readonly _tag: "UnknownGoalOrId"; readonly attempted: string }
  >;
  readonly pause: (
    sessionId: string,
    actor: { readonly name: string; readonly type: ActorType },
  ) => Effect.Effect<{ session: SessionRow; event: EventRow }, SessionError>;
  readonly close: (
    sessionId: string,
    actor: { readonly name: string; readonly type: ActorType },
  ) => Effect.Effect<{ session: SessionRow; event: EventRow }, SessionError>;
  readonly resume: (
    input: SessionResumeInput,
  ) => Effect.Effect<
    { session: SessionRow; event: EventRow; parent: SessionRow; forked: boolean },
    | SessionError
    | {
        readonly _tag: "UnknownSessionForResume";
        readonly attempted: string;
      }
    | {
        readonly _tag: "SessionAlreadyClosed";
        readonly sessionId: string;
      }
  >;
  readonly show: (
    sessionId: string,
  ) => Effect.Effect<SessionShowResult, SessionError | UnknownSession>;
  /**
   * Explicit snapshot trigger. Folds all events for the session and
   * writes a fresh snapshot row. Idempotent: if the latest snapshot
   * already covers every event, returns the existing row.
   */
  readonly takeSnapshot: (
    sessionId: string,
  ) => Effect.Effect<{ snapshot: SnapshotRow; taken: boolean }, SessionError | UnknownSession>;
}

export class SessionService extends Context.Tag("@cognit/db/SessionService")<
  SessionService,
  SessionServiceShape
>() {}

class UnknownGoalOrIdError {
  readonly _tag = "UnknownGoalOrId" as const;
  constructor(readonly attempted: string) {}
}

class UnknownSessionForResumeError {
  readonly _tag = "UnknownSessionForResume" as const;
  constructor(readonly attempted: string) {}
}

class SessionAlreadyClosedError {
  readonly _tag = "SessionAlreadyClosed" as const;
  constructor(readonly sessionId: string) {}
}

const nowIso = (): string => new Date().toISOString();

/** Insert a sessions row inside the supplied connection. Synchronous on the driver. */
const insertSessionRow = (
  conn: DbConnService,
  row: Omit<SessionRow, "last_snapshot_event_id" | "closed_at"> & {
    last_snapshot_event_id: string | null;
    closed_at: string | null;
  },
): void => {
  conn.handle.run(
    `INSERT INTO sessions (
       id, project_id, parent_session_id, goal, status,
       last_snapshot_event_id, created_at, closed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.project_id,
      row.parent_session_id,
      row.goal,
      row.status,
      row.last_snapshot_event_id,
      row.created_at,
      row.closed_at,
    ],
  );
};

const updateSessionStatus = (
  conn: DbConnService,
  id: string,
  status: SessionLifecycleStatus,
  closedAt: string | null,
): void => {
  conn.handle.run(`UPDATE sessions SET status = ?, closed_at = ? WHERE id = ?`, [
    status,
    closedAt,
    id,
  ]);
};

const fetchSession = (conn: DbConnService, id: string): SessionRow | undefined =>
  conn.handle.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", [id]);

/**
 * Build the SessionState for a session by reading all events and
 * folding them through the reducer. Returns `null` when the session
 * has no events yet.
 */
const foldSession = (
  conn: DbConnService,
  row: SessionRow,
): Effect.Effect<{ state: SessionState; events: ReadonlyArray<EventRow> }, DbError> =>
  Effect.gen(function* () {
    const events = yield* trySync(
      () =>
        conn.handle.all<EventRow>(
          "SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC",
          [row.id],
        ),
      (e) => new DbError({ message: "foldSession: list events", cause: e }),
    );
    const state = reduce(
      events,
      emptySessionState({
        session_id: row.id,
        project_id: row.project_id,
        goal: row.goal,
        parent_session_id: row.parent_session_id,
      }),
    );
    return { state, events };
  });

export const SessionServiceLive: Layer.Layer<
  SessionService,
  never,
  DbConnection | EventStore | SnapshotService | Uuid | Logger
> = Layer.effect(
  SessionService,
  Effect.gen(function* () {
    const conn: DbConnService = yield* DbConnection;
    const store: EventStoreService = yield* EventStore;
    const snapshots: SnapshotServiceT = yield* SnapshotService;
    const uuid: UuidService = yield* Uuid;
    const logger: LoggerService = yield* Logger;

    return {
      create: (input) =>
        Effect.gen(function* () {
          const sessionId = yield* uuid.make();
          const createdAt = nowIso();
          const goal = input.goal.trim();
          if (goal.length === 0) {
            return yield* Effect.fail(
              new DbError({ message: "session create: empty goal", cause: undefined }),
            );
          }
          // Insert sessions row, then append the session_created event.
          // The event log is the source of truth for the timeline; the
          // sessions row is a derived query index. Append must succeed
          // for the session to be visible to the reducer.
          yield* trySync(
            () =>
              insertSessionRow(conn, {
                id: sessionId,
                project_id: input.projectId,
                parent_session_id: input.parentSessionId ?? null,
                goal,
                status: "active",
                last_snapshot_event_id: null,
                created_at: createdAt,
                closed_at: null,
              }),
            (e) => new DbError({ message: "session create: insert", cause: e }),
          );
          const event = yield* store.append({
            id: sessionId,
            type: "session_created",
            payload: { goal, parent_session_id: input.parentSessionId ?? null },
            sessionId,
            actor: input.actor,
          });
          yield* logger.log(
            "info",
            { sessionId, goal: goal.slice(0, 80) },
            "session: created",
          );
          const row = fetchSession(conn, sessionId);
          if (!row) {
            return yield* Effect.fail(
              new DbError({ message: "session create: row missing post-insert", cause: undefined }),
            );
          }
          return { session: row, event };
        }),

      list: (q) =>
        Effect.sync((): ReadonlyArray<SessionRow> => {
          if (q.status) {
            return conn.handle.all<SessionRow>(
              "SELECT * FROM sessions WHERE project_id = ? AND status = ? ORDER BY created_at DESC, id DESC",
              [q.projectId, q.status],
            );
          }
          return conn.handle.all<SessionRow>(
            "SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC, id DESC",
            [q.projectId],
          );
        }).pipe(Effect.mapError((e) => new DbError({ message: "session list", cause: e }))),

      getByGoalOrId: (input) =>
        Effect.gen(function* () {
          if (input.id) {
            const row = yield* trySync(
              () => fetchSession(conn, input.id as string),
              (e) => new DbError({ message: "session getByGoalOrId: id", cause: e }),
            );
            if (!row) {
              return yield* Effect.fail(
                new UnknownGoalOrIdError(input.id as string),
              );
            }
            return { session: row, matches: [row], ambiguous: false };
          }
          if (input.goal === undefined || input.goal.length === 0) {
            return yield* Effect.fail(
              new UnknownGoalOrIdError("(empty goal)"),
            );
          }
          const goal = input.goal;
          const matches = yield* trySync(
            () =>
              conn.handle.all<SessionRow>(
                `SELECT * FROM sessions
                 WHERE project_id = ? AND status != 'closed' AND goal = ?
                 ORDER BY created_at DESC, id DESC`,
                [input.projectId, goal],
              ),
            (e) => new DbError({ message: "session getByGoalOrId: goal", cause: e }),
          );
          if (matches.length === 0) {
            return yield* Effect.fail(new UnknownGoalOrIdError(goal));
          }
          const preferRecent = input.preferMostRecent ?? true;
          const ambiguous = matches.length > 1;
          const session = preferRecent ? (matches[0] as SessionRow) : (matches[matches.length - 1] as SessionRow);
          return { session, matches, ambiguous };
        }),

      pause: (sessionId, actor) =>
        Effect.gen(function* () {
          const row = yield* trySync(
            () => fetchSession(conn, sessionId),
            (e) => new DbError({ message: "session pause: fetch", cause: e }),
          );
          if (!row) {
            return yield* Effect.fail(new UnknownSession({ sessionId }));
          }
          if (row.status === "paused") {
            yield* logger.log(
              "warning",
              { sessionId },
              "session: pause on already-paused session is a no-op",
            );
            return { session: row, event: row as unknown as EventRow };
          }
          if (row.status === "closed") {
            return yield* Effect.fail(
              new DbError({
                message: "session pause: cannot pause a closed session",
                cause: undefined,
              }),
            );
          }
          yield* trySync(
            () => updateSessionStatus(conn, sessionId, "paused", row.closed_at),
            (e) => new DbError({ message: "session pause: update", cause: e }),
          );
          const event = yield* store.append({
            type: "session_paused",
            payload: {},
            sessionId,
            actor,
          });
          yield* logger.log("info", { sessionId }, "session: paused");
          const updated = fetchSession(conn, sessionId);
          if (!updated) {
            return yield* Effect.fail(
              new DbError({ message: "session pause: row missing post-update", cause: undefined }),
            );
          }
          return { session: updated, event };
        }),

      close: (sessionId, actor) =>
        Effect.gen(function* () {
          const row = yield* trySync(
            () => fetchSession(conn, sessionId),
            (e) => new DbError({ message: "session close: fetch", cause: e }),
          );
          if (!row) {
            return yield* Effect.fail(new UnknownSession({ sessionId }));
          }
          if (row.status === "closed") {
            yield* logger.log(
              "warning",
              { sessionId },
              "session: close on already-closed session is a no-op",
            );
            return { session: row, event: row as unknown as EventRow };
          }
          const closedAt = nowIso();
          yield* trySync(
            () => updateSessionStatus(conn, sessionId, "closed", closedAt),
            (e) => new DbError({ message: "session close: update", cause: e }),
          );
          const event = yield* store.append({
            type: "session_closed",
            payload: {},
            sessionId,
            actor,
          });
          // On-close snapshot. Fold all events, write a snapshot at the
          // last event. Failure here is logged but does not roll back
          // the close — the event log is the source of truth, the
          // snapshot is a rebuild optimisation.
          const folded = yield* foldSession(conn, { ...row, status: "closed", closed_at: closedAt });
          if (folded.events.length > 0) {
            const lastEvent = folded.events[folded.events.length - 1] as EventRow;
            yield* Effect.gen(function* () {
              const result = yield* snapshots
                .write({
                  sessionId,
                  state: folded.state,
                  eventId: lastEvent.id,
                  eventCount: folded.events.length,
                })
                .pipe(Effect.either);
              if (result._tag === "Left") {
                yield* logger.log(
                  "warning",
                  { sessionId, error: String(result.left) },
                  "session close: snapshot write failed (continuing)",
                );
              }
            });
          }
          yield* logger.log("info", { sessionId }, "session: closed");
          const updated = fetchSession(conn, sessionId);
          if (!updated) {
            return yield* Effect.fail(
              new DbError({ message: "session close: row missing post-update", cause: undefined }),
            );
          }
          return { session: updated, event };
        }),

      resume: (input) =>
        Effect.gen(function* () {
          const fork = input.fork ?? true;
          // Resolve the target. idOrGoal is treated as id iff it looks
          // like a ULID (26 chars, starts with 01). Otherwise it's a goal.
          const isLikelyId = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(input.idOrGoal);
          let target: SessionRow | null = null;
          if (isLikelyId) {
            const row = yield* trySync(
              () => fetchSession(conn, input.idOrGoal),
              (e) => new DbError({ message: "session resume: id fetch", cause: e }),
            );
            if (!row) {
              return yield* Effect.fail(
                new UnknownSessionForResumeError(input.idOrGoal),
              );
            }
            target = row;
          } else {
            const goal = input.idOrGoal;
            const matches = yield* trySync(
              () =>
                conn.handle.all<SessionRow>(
                  `SELECT * FROM sessions
                   WHERE project_id = ? AND goal = ?
                   ORDER BY created_at DESC, id DESC`,
                  [input.projectId, goal],
                ),
              (e) => new DbError({ message: "session resume: goal fetch", cause: e }),
            );
            if (matches.length === 0) {
              return yield* Effect.fail(new UnknownSessionForResumeError(goal));
            }
            target = matches[0] as SessionRow;
          }

          if (target.status === "closed") {
            return yield* Effect.fail(new SessionAlreadyClosedError(target.id));
          }

          if (fork) {
            // Insert a new sessions row + append a session_created event
            // that links back to the parent. The new session becomes the
            // active one going forward; the parent remains untouched.
            const newSessionId = yield* uuid.make();
            const createdAt = nowIso();
            const suffix = ` (resumed ${createdAt.slice(0, 10)})`;
            const newGoal = `${target.goal}${suffix}`;
            yield* trySync(
              () =>
                insertSessionRow(conn, {
                  id: newSessionId,
                  project_id: input.projectId,
                  parent_session_id: target.id,
                  goal: newGoal,
                  status: "active",
                  last_snapshot_event_id: null,
                  created_at: createdAt,
                  closed_at: null,
                }),
              (e) => new DbError({ message: "session resume: fork insert", cause: e }),
            );
            const event = yield* store.append({
              id: newSessionId,
              type: "session_created",
              payload: { goal: newGoal, parent_session_id: target.id },
              sessionId: newSessionId,
              actor: input.actor,
            });
            yield* logger.log(
              "info",
              { newSessionId, parent: target.id },
              "session: resumed (fork)",
            );
            const newRow = fetchSession(conn, newSessionId);
            if (!newRow) {
              return yield* Effect.fail(
                new DbError({ message: "session resume: fork row missing", cause: undefined }),
              );
            }
            return { session: newRow, event, parent: target, forked: true };
          }

          // Reopen path: flip status back to active, clear closed_at.
          // The session's timeline continues uninterrupted.
          yield* trySync(
            () => updateSessionStatus(conn, target.id, "active", null),
            (e) => new DbError({ message: "session resume: reopen update", cause: e }),
          );
          const event = yield* store.append({
            type: "session_created",
            payload: { goal: target.goal, parent_session_id: target.parent_session_id },
            sessionId: target.id,
            actor: input.actor,
          });
          yield* logger.log("info", { sessionId: target.id }, "session: resumed (reopen)");
          const updated = fetchSession(conn, target.id);
          if (!updated) {
            return yield* Effect.fail(
              new DbError({ message: "session resume: reopen row missing", cause: undefined }),
            );
          }
          return { session: updated, event, parent: target, forked: false };
        }),

      show: (sessionId) =>
        Effect.gen(function* () {
          const row = yield* trySync(
            () => fetchSession(conn, sessionId),
            (e) => new DbError({ message: "session show: fetch", cause: e }),
          );
          if (!row) {
            return yield* Effect.fail(new UnknownSession({ sessionId }));
          }
          const events = yield* trySync(
            () =>
              conn.handle.all<EventRow>(
                "SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC",
                [sessionId],
              ),
            (e) => new DbError({ message: "session show: list events", cause: e }),
          );
          const snapshot = yield* trySync(
            () =>
              conn.handle.get<SnapshotRow>(
                "SELECT * FROM snapshots WHERE session_id = ? ORDER BY event_count DESC, created_at DESC LIMIT 1",
                [sessionId],
              ),
            (e) => new DbError({ message: "session show: latest snapshot", cause: e }),
          );
          let base: SessionState | undefined;
          let tail: ReadonlyArray<EventRow>;
          if (snapshot) {
            try {
              const parsed = JSON.parse(snapshot.state_json) as SessionState;
              base = parsed;
            } catch {
              base = undefined;
            }
            tail = events.filter((e) => e.id > snapshot.event_id);
          } else {
            base = undefined;
            tail = events;
          }
          const initial: SessionState = base ?? emptySessionState({
            session_id: row.id,
            project_id: row.project_id,
            goal: row.goal,
            parent_session_id: row.parent_session_id,
          });
          const state = reduce(tail, initial);
          return {
            session: row,
            state,
            snapshot: snapshot ?? null,
            tail_event_count: tail.length,
          };
        }),

      takeSnapshot: (sessionId) =>
        Effect.gen(function* () {
          const row = yield* trySync(
            () => fetchSession(conn, sessionId),
            (e) => new DbError({ message: "session takeSnapshot: fetch", cause: e }),
          );
          if (!row) {
            return yield* Effect.fail(new UnknownSession({ sessionId }));
          }
          const events = yield* trySync(
            () =>
              conn.handle.all<EventRow>(
                "SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC",
                [sessionId],
              ),
            (e) => new DbError({ message: "session takeSnapshot: list events", cause: e }),
          );
          if (events.length === 0) {
            return yield* Effect.fail(
              new DbError({
                message: "session takeSnapshot: no events to snapshot",
                cause: undefined,
              }),
            );
          }
          const existing = yield* snapshots.latestForSession(sessionId);
          if (existing && existing.event_count >= events.length) {
            return { snapshot: existing, taken: false };
          }
          const state = reduce(
            events,
            emptySessionState({
              session_id: row.id,
              project_id: row.project_id,
              goal: row.goal,
              parent_session_id: row.parent_session_id,
            }),
          );
          const lastEvent = events[events.length - 1] as EventRow;
          const written = yield* snapshots.write({
            sessionId,
            state,
            eventId: lastEvent.id,
            eventCount: events.length,
          });
          yield* logger.log(
            "info",
            { sessionId, eventCount: events.length, snapshotId: written.id },
            "session: snapshot taken",
          );
          return { snapshot: written, taken: true };
        }),
    };
  }),
);
