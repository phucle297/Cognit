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
 * Resume-as-fork and the reducer view are added in bead 2e. Bead 2c
 * ships the simple CRUD + lifecycle only.
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
import type { EventRow, SessionRow } from "./schema/rows";
import { Uuid } from "./ulid";

export type SessionError = DbError | UnknownEventType | ValidationFailure | UnknownSession;

type DbConnService = Context.Tag.Service<typeof DbConnection>;
type EventStoreService = Context.Tag.Service<typeof EventStore>;
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
}

export class SessionService extends Context.Tag("@cognit/db/SessionService")<
  SessionService,
  SessionServiceShape
>() {}

class UnknownGoalOrIdError {
  readonly _tag = "UnknownGoalOrId" as const;
  constructor(readonly attempted: string) {}
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

export const SessionServiceLive: Layer.Layer<
  SessionService,
  never,
  DbConnection | EventStore | Uuid | Logger
> = Layer.effect(
  SessionService,
  Effect.gen(function* () {
    const conn: DbConnService = yield* DbConnection;
    const store: EventStoreService = yield* EventStore;
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
          yield* logger.log("info", { sessionId }, "session: closed");
          const updated = fetchSession(conn, sessionId);
          if (!updated) {
            return yield* Effect.fail(
              new DbError({ message: "session close: row missing post-update", cause: undefined }),
            );
          }
          return { session: updated, event };
        }),
    };
  }),
);
