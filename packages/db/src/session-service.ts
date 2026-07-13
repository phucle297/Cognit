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
  SessionClosed,
  ConstraintViolation,
  UnknownEventType,
  UnknownSession,
  ValidationFailure,
  trySync,
} from "./errors";
import type { ActorType } from "./actor";
import type { EventRow, SessionRow, SnapshotRow } from "./schema/rows";
import { Uuid } from "./ulid";
import { reduce } from "@cognit/core/reducer";
import { ConstraintPolicy } from "./constraint-policy";
import {
  CONSTRAINT_ENGINE_ACTOR_NAME,
  TRANSFORM_TRIGGER_TYPES,
  evalRules,
  evalTransformRules,
  type CandidateEvent,
  type ConstraintActionDedup,
  type EmitConstraintEvent,
} from "./constraint-engine";
import { emptySessionState, type SessionState } from "@cognit/core/state";
import { parseSnapshotStateJson } from "@cognit/core/serialize-state";
import { rehydrateSessionState, SnapshotService } from "./snapshot-service";
import { SessionPolicy } from "./session-policy";
import { EventBus } from "./bus";
import type { AppendEventInput } from "./event-store";

export type SessionError =
  | DbError
  | SessionClosed
  | UnknownEventType
  | ValidationFailure
  | UnknownSession
  | ConstraintViolation;

type DbConnService = Context.Tag.Service<typeof DbConnection>;
type EventStoreService = Context.Tag.Service<typeof EventStore>;
type SnapshotServiceT = Context.Tag.Service<typeof SnapshotService>;
type UuidService = Context.Tag.Service<typeof Uuid>;
type LoggerService = Context.Tag.Service<typeof Logger>;
type EventBusT = Context.Tag.Service<typeof EventBus>;

export type SessionLifecycleStatus = "active" | "paused" | "closed";

export interface SessionCreateInput {
  readonly projectId: string;
  readonly goal: string;
  readonly parentSessionId?: string | null;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface SessionAppendEventInput {
  readonly sessionId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly actor: { readonly name: string; readonly type: ActorType };
  /**
   * Optional explicit event id. Mirrors `AppendEventInput.id` and is
   * forwarded to `EventStore.append` unchanged. The inbox pipeline
   * uses this to make writes idempotent on file rename + reprocess.
   */
  readonly id?: string;
  readonly source?: AppendEventInput["source"];
  readonly artifactRefs?: AppendEventInput["artifactRefs"];
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly confidence?: number;
  readonly parentVerificationId?: string;
  readonly linkedHypothesisId?: string;
}

export interface SessionAppendEventResult {
  readonly event: EventRow;
  readonly snapshotTaken: boolean;
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
  /** Alias of `tail_event_count` — number of events applied after the snapshot. */
  readonly eventsAfterSnapshot: number;
}

export interface SessionServiceShape {
  readonly create: (
    input: SessionCreateInput,
  ) => Effect.Effect<{ session: SessionRow; event: EventRow }, SessionError>;
  readonly list: (q: SessionListQuery) => Effect.Effect<ReadonlyArray<SessionRow>, DbError>;
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
  readonly resume: (input: SessionResumeInput) => Effect.Effect<
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
  /**
   * Append an event to an open session, triggering an auto-snapshot
   * via `SessionPolicy.everyN` when the threshold is crossed. Fails
   * with `UnknownSession` if the session id is unknown, and with
   * `DbError` if the session is already closed.
   */
  readonly appendEvent: (
    input: SessionAppendEventInput,
  ) => Effect.Effect<SessionAppendEventResult, SessionError>;
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
  | DbConnection
  | EventStore
  | SnapshotService
  | Uuid
  | Logger
  | SessionPolicy
  | ConstraintPolicy
  | EventBus
> = Layer.effect(
  SessionService,
  Effect.gen(function* () {
    const conn: DbConnService = yield* DbConnection;
    const store: EventStoreService = yield* EventStore;
    const snapshots: SnapshotServiceT = yield* SnapshotService;
    const uuid: UuidService = yield* Uuid;
    const logger: LoggerService = yield* Logger;
    const policy: Context.Tag.Service<typeof SessionPolicy> = yield* SessionPolicy;
    const constraintPolicy = yield* ConstraintPolicy;
    const eventBus: EventBusT = yield* EventBus;

    // Private helper: the snapshot+tail replay path. Used by both
    // `show` (the public read API) and `appendEvent` (phase 3c
    // constraint check, which needs the current SessionState to
    // evaluate rules).
    const _show = (
      sessionId: string,
    ): Effect.Effect<SessionShowResult, SessionError> =>
      Effect.gen(function* () {
        const row = yield* trySync(
          () => fetchSession(conn, sessionId),
          (e) => new DbError({ message: "session show: fetch", cause: e }),
        );
        if (!row) {
          return yield* Effect.fail(new UnknownSession({ sessionId }));
        }
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
        let usableSnapshot: SnapshotRow | null = snapshot ?? null;

        if (snapshot) {
          const parsed = parseSnapshotStateJson(snapshot.state_json);
          if (parsed) {
            base = rehydrateSessionState(parsed.state);
            // Belt-and-braces: never trust blank session/project ids from
            // legacy snapshots written with bare `reduce` (pre-M1).
            base = {
              ...base,
              session_id: base.session_id || row.id,
              project_id: base.project_id || row.project_id,
              goal: base.goal || row.goal,
              parent_session_id: base.parent_session_id ?? row.parent_session_id,
              snapshot_event_id: base.snapshot_event_id ?? snapshot.event_id,
            };
            // D-M1-02: tail SQL — only events after the snapshot id.
            // ULID string order ≡ chronological for this product.
            tail = yield* trySync(
              () =>
                conn.handle.all<EventRow>(
                  "SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY created_at ASC, id ASC",
                  [sessionId, snapshot.event_id],
                ),
              (e) => new DbError({ message: "session show: list tail events", cause: e }),
            );
          } else {
            yield* logger.log(
              "warning",
              { sessionId, snapshotId: snapshot.id },
              "session show: snapshot schema unsupported or corrupt, falling back to full replay",
            );
            base = undefined;
            usableSnapshot = null;
            tail = yield* trySync(
              () =>
                conn.handle.all<EventRow>(
                  "SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC",
                  [sessionId],
                ),
              (e) => new DbError({ message: "session show: list events", cause: e }),
            );
          }
        } else {
          base = undefined;
          tail = yield* trySync(
            () =>
              conn.handle.all<EventRow>(
                "SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC",
                [sessionId],
              ),
            (e) => new DbError({ message: "session show: list events", cause: e }),
          );
        }

        const initial: SessionState =
          base ??
          emptySessionState({
            session_id: row.id,
            project_id: row.project_id,
            goal: row.goal,
            parent_session_id: row.parent_session_id,
          });
        const state = reduce(tail, initial);
        return {
          session: row,
          state,
          snapshot: usableSnapshot,
          tail_event_count: tail.length,
          eventsAfterSnapshot: tail.length,
        };
      });

    /**
     * Append an event to the store and, if the per-session event
     * count crosses the policy threshold, trigger an auto-snapshot.
     *
     * The snapshot step is best-effort: a `takeIfDue` failure is
     * logged and swallowed so the append still succeeds. The event
     * log is the source of truth; the snapshot is a rebuild
     * optimisation.
     *
     * Single bus chokepoint: every event inserted by SessionService
     * (lifecycle + user events, `appendEvent` + the inbox watcher)
     * fans out to subscribers here, exactly once. Bus errors are
     * ignored — the bus is observability, the event log is the
     * system of record. Callers MUST NOT publish in parallel.
     *
     * Phase 8 v0.2 (Cognit-8g.3): after a successful append, runs the
     * post-append constraint transformer when the trigger event type is
     * in {experiment_completed, verification_failed}. Emitted events
     * are inserted via `store.append` directly (NOT via a recursive
     * `service.appendEvent` call) — this keeps the emit path out of
     * the pre-append rule check AND prevents the public chokepoint
     * from re-entering the transformer for the emitted event. The
     * payload flag `__constraint_emitted = true` is the loop guard
     * carried by every emitted event (also belt-and-braces against
     * any future code path that calls `evalTransformRules` directly).
     */
    const _appendAndMaybeSnapshot = (
      input: AppendEventInput,
    ): Effect.Effect<SessionAppendEventResult, SessionError> =>
      Effect.gen(function* () {
        const event = yield* store.append(input);

        // Post-append transformer (Cognit-8g.3). Only runs on the
        // trigger event types; other event types fall through to
        // the snapshot/bus path unchanged. The transformer re-folds
        // state via `_show` because the just-appended event is
        // materialised in the log but not in any cached state.
        if (
          TRANSFORM_TRIGGER_TYPES.has(event.type) &&
          input.type !== "constraint_rule_added" &&
          input.type !== "constraint_rule_applied"
        ) {
          const rules = yield* constraintPolicy.loadRules(event.session_id);
          if (rules.length > 0) {
            const post = yield* _show(event.session_id).pipe(
              Effect.mapError(
                (e) =>
                  new DbError({
                    message: "appendEvent: post-transform state fetch",
                    cause: e,
                  }),
              ),
            );
            // Dedup backed by the SQLite table. INSERT OR IGNORE;
            // `changes()` returns 1 on insert, 0 on duplicate.
            const dedup: ConstraintActionDedup = {
              insertIfNew: (key) => {
                const res = conn.handle.run(
                  `INSERT OR IGNORE INTO constraint_action_log
                     (event_id, rule_id, action_type, fired_at)
                     VALUES (?, ?, ?, ?)`,
                  [key.eventId, key.ruleId, key.actionType, key.firedAt],
                );
                return res.changes > 0;
              },
            };
            // Emit goes straight to the EventStore, NOT through
            // `service.appendEvent`. This avoids re-entering the
            // pre-append rule check on emitted events AND keeps the
            // emit path free of the public chokepoint's contract.
            // The `__constraint_emitted` payload flag plus the
            // dedup table together guarantee no infinite recursion.
            //
            // The transformer expects `emit: EmitConstraintEvent`
            // which has error channel `never`. We satisfy that by
            // catching every EventStore error here and returning a
            // synthetic `null` row — the transformer treats the
            // returned row as opaque (it does not inspect the value),
            // and the outer pipeline logs the swallowed error so the
            // operator can investigate without losing the original
            // append.
            const emit: EmitConstraintEvent = ({ type, payload }) =>
              store
                .append({
                  sessionId: event.session_id,
                  type,
                  payload,
                  actor: {
                    name: CONSTRAINT_ENGINE_ACTOR_NAME,
                    type: "system",
                  },
                  causationId: event.id,
                  // EventRow.correlation_id is nullable; the
                  // chokepoint's input field is non-nullable, so
                  // forward only when present.
                  ...(event.correlation_id !== null
                    ? { correlationId: event.correlation_id }
                    : {}),
                })
                .pipe(
                  Effect.tapError((e) =>
                    logger.log(
                      "warning",
                      { sessionId: event.session_id, type, error: String(e) },
                      "constraint transformer: emit insert failed (continuing)",
                    ),
                  ),
                  Effect.orElseSucceed(() => null as unknown as EventRow),
                ) as unknown as Effect.Effect<unknown, never>;
            // The transformer's emit path is wrapped to swallow
            // errors via `Effect.orElseSucceed` (see emit above) so
            // the transformer's typed error channel is `never`. The
            // trigger event row is already persisted; a transformer
            // failure to emit a follow-up mutation is logged inside
            // `emit` and the append still succeeds.
            yield* evalTransformRules(
              {
                id: event.id,
                type: event.type,
                payload: (() => {
                  try {
                    return JSON.parse(event.payload_json) as Record<string, unknown>;
                  } catch {
                    return {};
                  }
                })(),
              },
              post.state,
              rules,
              dedup,
              emit,
              // Sync ULID factory. The transformer only calls
              // this for `promote_hypothesis` (to synthesise a
              // theory id); the live `Uuid.make` is a sync
              // `Effect.sync` under the hood, so we run it
              // synchronously. If `Uuid.make` ever becomes truly
              // async, the transformer needs a typed upgrade.
              () => Effect.runSync(uuid.make()) as string,
            );
          }
        }

        const countRow = yield* trySync(
          () =>
            conn.handle.get<{ c: number }>(
              "SELECT COUNT(*) AS c FROM events WHERE session_id = ?",
              [input.sessionId],
            ),
          (e) => new DbError({ message: "session append: count events", cause: e }),
        );
        const count = countRow?.c ?? 0;
        // Seed emptySessionState from the sessions row so cold reduce
        // (first snapshot / invalid prior) keeps session_id + project_id.
        // Bare `build: reduce` left those fields "" forever after rehydrate
        // (D-M1-02 equality AC / quality-gate finding).
        const sessionRow = yield* trySync(
          () => fetchSession(conn, input.sessionId),
          (e) => new DbError({ message: "session append: fetch session", cause: e }),
        );
        const result = yield* snapshots
          .takeIfDue({
            sessionId: input.sessionId,
            currentEventCount: count,
            everyN: policy.everyN,
            build: (events) =>
              reduce(
                events,
                emptySessionState({
                  session_id: input.sessionId,
                  project_id: sessionRow?.project_id ?? "",
                  goal: sessionRow?.goal ?? "",
                  parent_session_id: sessionRow?.parent_session_id ?? null,
                }),
              ),
          })
          .pipe(Effect.either);
        if (result._tag === "Left") {
          yield* logger.log(
            "warning",
            { sessionId: input.sessionId, error: String(result.left) },
            "session append: auto-snapshot failed (continuing)",
          );
          yield* eventBus.publish(event).pipe(Effect.ignoreLogged);
          return { event, snapshotTaken: false };
        }
        yield* eventBus.publish(event).pipe(Effect.ignoreLogged);
        return { event, snapshotTaken: result.right !== null };
      });

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
          const { event } = yield* _appendAndMaybeSnapshot({
            id: sessionId,
            type: "session_created",
            payload: { goal, parent_session_id: input.parentSessionId ?? null },
            sessionId,
            actor: input.actor,
          });
          yield* logger.log("info", { sessionId, goal: goal.slice(0, 80) }, "session: created");
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
              return yield* Effect.fail(new UnknownGoalOrIdError(input.id as string));
            }
            return { session: row, matches: [row], ambiguous: false };
          }
          if (input.goal === undefined || input.goal.length === 0) {
            return yield* Effect.fail(new UnknownGoalOrIdError("(empty goal)"));
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
          const session = preferRecent
            ? (matches[0] as SessionRow)
            : (matches[matches.length - 1] as SessionRow);
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
          const { event } = yield* _appendAndMaybeSnapshot({
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
          const { event } = yield* _appendAndMaybeSnapshot({
            type: "session_closed",
            payload: {},
            sessionId,
            actor,
          });
          // On-close snapshot. Fold all events, write a snapshot at the
          // last event. Failure here is logged but does not roll back
          // the close — the event log is the source of truth, the
          // snapshot is a rebuild optimisation.
          const folded = yield* foldSession(conn, {
            ...row,
            status: "closed",
            closed_at: closedAt,
          });
          if (folded.events.length > 0) {
            const lastEvent = folded.events[folded.events.length - 1] as EventRow;
            // If a previous auto-snapshot (e.g. with everyN=1) already
            // covers every event, skip the redundant write.
            const existing = yield* snapshots.latestForSession(sessionId);
            if (existing && existing.event_count >= folded.events.length) {
              yield* logger.log(
                "info",
                {
                  sessionId,
                  eventCount: folded.events.length,
                  snapshotId: existing.id,
                },
                "session close: snapshot already current, skipping",
              );
            } else {
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
              return yield* Effect.fail(new UnknownSessionForResumeError(input.idOrGoal));
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
            const { event } = yield* _appendAndMaybeSnapshot({
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
          const { event } = yield* _appendAndMaybeSnapshot({
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

      show: (sessionId) => _show(sessionId),

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

      appendEvent: (input) =>
        Effect.gen(function* () {
          const row = yield* trySync(
            () => fetchSession(conn, input.sessionId),
            (e) => new DbError({ message: "session appendEvent: fetch", cause: e }),
          );
          if (!row) {
            return yield* Effect.fail(new UnknownSession({ sessionId: input.sessionId }));
          }
          if (row.status === "closed") {
            return yield* Effect.fail(new SessionClosed({ sessionId: input.sessionId }));
          }

          // Phase 3c: constraint engine check. The chokepoint is
          // public, so CLI / 3a / 3d / inbox watcher all funnel
          // through here. Skip the check for `constraint_rule_added`
          // itself — adding a rule must not require permission from
          // the same rule set.
          // `matchedNonBlock` is the audit hook for v2 non-block
          // actions: when the engine matched rules but did not block,
          // we hand the ids to the append so it writes a
          // `constraint_rule_applied` event in the same tx. v1 rules
          // are block-only, so this list is always empty today.
          let matchedNonBlock: ReadonlyArray<string> | undefined;
          if (input.type !== "constraint_rule_added" && input.type !== "constraint_rule_applied") {
            const rules = yield* constraintPolicy.loadRules(input.sessionId);
            if (rules.length > 0) {
              // Load current state via the snapshot+tail path.
              const show = yield* _show(input.sessionId).pipe(
                Effect.mapError(
                  (e) =>
                    new DbError({
                      message: "appendEvent: constraint state fetch",
                      cause: e,
                    }),
                ),
              );
              const candidate: CandidateEvent = {
                type: input.type,
                payload: input.payload as Readonly<Record<string, unknown>>,
                actorTrustScore: 1.0, // v1: no actor trust score column yet
                sessionEventCount: show.eventsAfterSnapshot,
              };
              const result = evalRules(rules, show.state, candidate);
              if (!result.allow && result.violation) {
                return yield* Effect.fail(
                  new ConstraintViolation({
                    ruleId: result.violation.ruleId,
                    reason: result.violation.reason,
                    eventType: input.type,
                    sessionId: input.sessionId,
                  }),
                );
              }
              if (result.allow && result.matchedRuleIds.length > 0) {
                matchedNonBlock = result.matchedRuleIds;
              }
            }
          }

          return yield* _appendAndMaybeSnapshot({
            type: input.type,
            payload: input.payload,
            sessionId: input.sessionId,
            actor: input.actor,
            ...(input.id !== undefined ? { id: input.id } : {}),
            ...(input.source !== undefined ? { source: input.source } : {}),
            ...(input.artifactRefs !== undefined ? { artifactRefs: input.artifactRefs } : {}),
            ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
            ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
            ...(input.parentVerificationId !== undefined
              ? { parentVerificationId: input.parentVerificationId }
              : {}),
            ...(input.linkedHypothesisId !== undefined
              ? { linkedHypothesisId: input.linkedHypothesisId }
              : {}),
            ...(matchedNonBlock !== undefined
              ? { constraintMatchedRuleIds: matchedNonBlock }
              : {}),
          });
        }),
    };
  }),
);
