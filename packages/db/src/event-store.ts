import { Context, Effect, Either, Layer, Schema } from "effect";
import { DbConnection, EventStore, Logger, Redactor } from "./context";
import {
  DbError,
  DuplicateEventId,
  NotFound,
  UnknownEventType,
  UnknownSession,
  ValidationFailure,
  trySync,
} from "./errors";
import { CURRENT_VERSION, EVENT_TYPES, PAYLOAD_SCHEMAS_V1 } from "./event-schema";
import { redactEvent } from "./redaction";
import type { EventRow } from "./schema/rows";
import { Uuid } from "./ulid";
import type { ActorType } from "./actor";

export interface AppendEventInput {
  readonly id?: string;
  readonly type: string;
  readonly payload: unknown;
  readonly sessionId: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly source?: {
    readonly tool: string;
    readonly command: string;
    /**
     * Stored as `file_path` snake_case in `source_json` to match the
     * on-disk JSON convention used by inbox ingestion.
     */
    readonly filePath?: string;
  };
  readonly artifactRefs?: ReadonlyArray<string>;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly confidence?: number;
  readonly parentVerificationId?: string;
  readonly linkedHypothesisId?: string;
  /**
   * Rule ids from the constraint engine that matched a non-blocking
   * rule during the chokepoint's evaluation. When set, the append
   * will emit a `constraint_rule_applied` audit event for each id in
   * the same transaction. v1 rules are block-only, so the chokepoint
   * never sets this today; v2 (non-block actions) will populate it.
   */
  readonly constraintMatchedRuleIds?: ReadonlyArray<string>;
}

export interface ListEventsQuery {
  readonly sessionId: string;
  readonly afterEventId?: string;
  readonly afterCreatedAt?: string;
  readonly type?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListEventsResult {
  readonly events: ReadonlyArray<EventRow>;
  readonly nextCursor?: string;
}

export type { EventRow } from "./schema/rows";

const DEFAULT_TRUST_BY_TYPE: Readonly<Record<ActorType, number>> = {
  human: 0.9,
  worker: 0.6,
  system: 1.0,
};

type DbConnService = Context.Tag.Service<typeof DbConnection>;
type UuidService = Context.Tag.Service<typeof Uuid>;
type LoggerService = Context.Tag.Service<typeof Logger>;

const nowIso = (): string => new Date().toISOString();

/**
 * Ensure an actor with the given name exists. If not, register it with
 * the default trust_score from `defaultTrustByType`. Updates last_seen_at.
 *
 * All SQLite calls are wrapped in `trySync` so any driver throw becomes a
 * typed `DbError` in the Effect error channel. This is critical: the
 * `conn.handle.tx` wrapper only triggers ROLLBACK on `Effect.fail`, so
 * letting a sync throw escape would leave the tx open.
 */
const ensureActor = (
  conn: DbConnService,
  uuid: UuidService,
  name: string,
  type: ActorType,
): Effect.Effect<string, DbError> =>
  Effect.gen(function* () {
    const h = conn.handle;
    const existing = yield* trySync(
      () => h.get<{ id: string }>("SELECT id FROM actors WHERE name = ?", [name]),
      (e) => new DbError({ message: "ensureActor: select", cause: e }),
    );
    if (existing) {
      yield* trySync(
        () => h.run("UPDATE actors SET last_seen_at = ? WHERE id = ?", [nowIso(), existing.id]),
        (e) => new DbError({ message: "ensureActor: update last_seen_at", cause: e }),
      );
      return existing.id;
    }
    const id = yield* uuid.make();
    const trust = DEFAULT_TRUST_BY_TYPE[type];
    yield* trySync(
      () =>
        h.run(
          `INSERT INTO actors (id, type, name, trust_score, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, type, name, trust, nowIso(), nowIso()],
        ),
      (e) => new DbError({ message: "ensureActor: insert", cause: e }),
    );
    return id;
  });

/**
 * Insert a single event row. Caller is responsible for ensuring it's
 * inside a transaction. Returns the inserted row. Throws synchronously on
 * driver error (caught at the call site via `trySync`).
 */
const insertEvent = (
  conn: DbConnService,
  row: Omit<EventRow, "created_at"> & { created_at: string },
): EventRow => {
  conn.handle.run(
    `INSERT INTO events (
       id, project_id, session_id, actor_id, type, version,
       payload_json, source_json, artifact_refs_json,
       causation_id, correlation_id, confidence,
       parent_verification_id, linked_hypothesis_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.project_id,
      row.session_id,
      row.actor_id,
      row.type,
      row.version,
      row.payload_json,
      row.source_json,
      row.artifact_refs_json,
      row.causation_id,
      row.correlation_id,
      row.confidence,
      row.parent_verification_id,
      row.linked_hypothesis_id,
      row.created_at,
    ],
  );
  return row as EventRow;
};

/**
 * Look up an event row by id. Returns the row or undefined. Throws
 * synchronously on driver error (caught at the call site via `trySync`).
 */
const fetchEvent = (conn: DbConnService, id: string): EventRow | undefined =>
  conn.handle.get<EventRow>("SELECT * FROM events WHERE id = ?", [id]);

/**
 * Build the live `EventStore` Layer. Depends on DbConnection, Redactor,
 * Uuid, Logger.
 */
export const EventStoreLive: Layer.Layer<
  EventStore,
  never,
  DbConnection | Redactor | Uuid | Logger
> = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const conn = yield* DbConnection;
    const redactor = yield* Redactor;
    const uuid = yield* Uuid;
    const logger: LoggerService = yield* Logger;

    return {
      append: (input) =>
        Effect.gen(function* () {
          const eventId = input.id ?? (yield* uuid.make());
          const known = EVENT_TYPES as ReadonlyArray<string>;
          if (!known.includes(input.type)) {
            return yield* Effect.fail(
              new UnknownEventType({ type: input.type, knownTypes: known }),
            );
          }

          // Validate payload against the per-type, current-version Schema.
          // `redaction_applied` events are system-emitted, not user-supplied,
          // so they skip user-side validation.
          if (input.type !== "redaction_applied") {
            const schema = PAYLOAD_SCHEMAS_V1[input.type] as
              | Schema.Schema<any, any, never>
              | undefined;
            if (schema) {
              const decoded = Schema.decodeUnknownEither(schema)(input.payload);
              if (Either.isLeft(decoded)) {
                return yield* Effect.fail(
                  new ValidationFailure({
                    type: input.type,
                    version: CURRENT_VERSION,
                    issues: String(decoded.left),
                  }),
                );
              }
            }
          }

          // Resolve session -> project_id. Wrapped in trySync so a sync
          // throw becomes a typed DbError, and UnknownSession takes
          // precedence when the row is simply absent.
          const session = yield* trySync(
            () =>
              conn.handle.get<{ id: string; project_id: string }>(
                "SELECT id, project_id FROM sessions WHERE id = ?",
                [input.sessionId],
              ),
            (e) => new DbError({ message: "append: select session", cause: e }),
          );
          if (!session) {
            return yield* Effect.fail(new UnknownSession({ sessionId: input.sessionId }));
          }

          // Run append + redaction side-effects in one transaction.
          return yield* conn.handle.tx(() =>
            Effect.gen(function* () {
              // Idempotency check INSIDE the tx, before insert. Two
              // concurrent appends with the same id may both miss this
              // check; the INSERT below then fails with a UNIQUE
              // constraint, which is caught and re-fetched.
              const existing = yield* trySync(
                () => fetchEvent(conn, eventId),
                (e) => new DbError({ message: "append: idempotency fetch", cause: e }),
              );
              if (existing) {
                yield* logger.log(
                  "debug",
                  { eventId, type: input.type },
                  "append: duplicate id, returning existing",
                );
                return existing;
              }

              const actorId = yield* ensureActor(conn, uuid, input.actor.name, input.actor.type);

              // Apply redaction. Redaction must be inside the tx so that
              // the redaction_applied event is atomic with the main row.
              const sourceJson = input.source
                ? {
                    tool: input.source.tool,
                    command: input.source.command,
                    file_path: input.source.filePath,
                  }
                : undefined;

              const { redactedPayload, redactedSource, hits } = redactEvent(
                input.payload,
                sourceJson,
                redactor,
              );

              // Capture created_at once and reuse for the main event and
              // every redaction_applied hit so the side-effect rows
              // cannot sort after the main row.
              const createdAt = nowIso();
              const inserted = yield* trySync(
                () =>
                  insertEvent(conn, {
                    id: eventId,
                    project_id: session.project_id,
                    session_id: input.sessionId,
                    actor_id: actorId,
                    type: input.type,
                    version: CURRENT_VERSION,
                    payload_json: JSON.stringify(redactedPayload),
                    source_json:
                      redactedSource === undefined ? null : JSON.stringify(redactedSource),
                    artifact_refs_json: input.artifactRefs
                      ? JSON.stringify(input.artifactRefs)
                      : null,
                    causation_id: input.causationId ?? null,
                    correlation_id: input.correlationId ?? null,
                    confidence: input.confidence ?? null,
                    parent_verification_id: input.parentVerificationId ?? null,
                    linked_hypothesis_id: input.linkedHypothesisId ?? null,
                    created_at: createdAt,
                  }),
                (e) => {
                  if (
                    e !== null &&
                    typeof e === "object" &&
                    "code" in e &&
                    (e as { code: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
                  ) {
                    return new DuplicateEventId({ id: eventId });
                  }
                  return new DbError({ message: "append: insert event", cause: e });
                },
              ).pipe(
                // Lost the idempotency race: another tx inserted first.
                // Re-fetch and return the canonical row.
                Effect.catchTag("DuplicateEventId", () =>
                  trySync(
                    () => {
                      const row = fetchEvent(conn, eventId);
                      if (!row) {
                        throw new DbError({
                          message: "append: duplicate but row missing on re-fetch",
                          cause: undefined,
                        });
                      }
                      return row;
                    },
                    (e) => new DbError({ message: "append: re-fetch on duplicate", cause: e }),
                  ),
                ),
              );

              // Emit redaction_applied per hit. Each gets its own id.
              for (const hit of hits) {
                if (hit.fieldPath === "") continue;
                const redactionId = yield* uuid.make();
                yield* trySync(
                  () =>
                    insertEvent(conn, {
                      id: redactionId,
                      project_id: session.project_id,
                      session_id: input.sessionId,
                      actor_id: actorId,
                      type: "redaction_applied",
                      version: CURRENT_VERSION,
                      payload_json: JSON.stringify({
                        pattern: hit.pattern,
                        entity_type: input.type,
                        entity_id: eventId,
                        field_path: hit.fieldPath,
                      }),
                      source_json: null,
                      artifact_refs_json: null,
                      causation_id: eventId,
                      correlation_id: input.correlationId ?? null,
                      confidence: null,
                      parent_verification_id: null,
                      linked_hypothesis_id: null,
                      created_at: createdAt,
                    }),
                  (e) => new DbError({ message: "append: insert redaction_applied", cause: e }),
                );
              }

              // Emit constraint_rule_applied per matched non-blocking
              // rule. Each gets its own ULID. The audit event uses the
              // same `createdAt`, actor, and session as the main event
              // so the audit row sorts at the same instant and cannot
              // leak across tx boundaries. v1 rules are block-only, so
              // the chokepoint never populates this list; v2 (non-block
              // actions) will. Skipping an empty list is a no-op.
              for (const ruleId of input.constraintMatchedRuleIds ?? []) {
                const auditId = yield* uuid.make();
                yield* trySync(
                  () =>
                    insertEvent(conn, {
                      id: auditId,
                      project_id: session.project_id,
                      session_id: input.sessionId,
                      actor_id: actorId,
                      type: "constraint_rule_applied",
                      version: CURRENT_VERSION,
                      payload_json: JSON.stringify({
                        rule_id: ruleId,
                        affected_hypothesis_ids: [],
                      }),
                      source_json: null,
                      artifact_refs_json: null,
                      causation_id: eventId,
                      correlation_id: input.correlationId ?? null,
                      confidence: null,
                      parent_verification_id: null,
                      linked_hypothesis_id: null,
                      created_at: createdAt,
                    }),
                  (e) =>
                    new DbError({ message: "append: insert constraint_rule_applied", cause: e }),
                );
              }

              yield* logger.log(
                "info",
                {
                  eventId,
                  type: input.type,
                  sessionId: input.sessionId,
                  redactions: hits.length,
                },
                "append: ok",
              );
              return inserted;
            }),
          );
        }),

      list: (q) =>
        Effect.sync((): { events: ReadonlyArray<EventRow>; nextCursor?: string } => {
          const h = conn.handle;
          const limit = Math.min(q.limit ?? 100, 1000);
          const conditions: string[] = ["session_id = ?"];
          const params: unknown[] = [q.sessionId];
          if (q.type) {
            conditions.push("type = ?");
            params.push(q.type);
          }
          if (q.afterEventId) {
            conditions.push("id > ?");
            params.push(q.afterEventId);
          }
          if (q.afterCreatedAt) {
            conditions.push("created_at > ?");
            params.push(q.afterCreatedAt);
          }
          const sql = `SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC, id ASC LIMIT ?`;
          const rows = h.all<EventRow>(sql, [...params, limit + 1]);
          const hasMore = rows.length > limit;
          const events: ReadonlyArray<EventRow> = hasMore ? rows.slice(0, limit) : rows;
          const nextCursor = hasMore ? events[events.length - 1]?.id : undefined;
          return nextCursor !== undefined ? { events, nextCursor } : { events };
        }),

      get: (id) =>
        Effect.sync(() => fetchEvent(conn, id)).pipe(
          Effect.flatMap((row) =>
            row === undefined
              ? Effect.fail(new NotFound({ entity: "event", id }))
              : Effect.succeed(row),
          ),
        ),
    };
  }),
);
