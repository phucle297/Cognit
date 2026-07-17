/**
 * RawEventStore — D-M6-00 dual logical event store (Option A).
 *
 * Persists redacted full wire envelopes in `raw_events`. Domain
 * summaries stay in `events`. Soft link: events.correlation_id →
 * raw_events.id. Redaction always runs inside append (callers must
 * not pre-skip). Upsert: first-write-wins envelope_json; always
 * refresh domain_event_count.
 */
import { Context, Effect, Layer } from "effect";
import { DbConnection, Logger, Redactor } from "./context";
import { DbError, NotFound, trySync } from "./errors";
import type { ActorType } from "./actor";
import type { RawEventRow } from "./schema/rows";

const ONE_MIB = 1_048_576;

const nowIso = (): string => new Date().toISOString();

export interface AppendRawEventInput {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly type: string;
  readonly version: string;
  readonly actorName: string;
  readonly actorType: ActorType;
  /** Unredacted wire object (snake_case top-level). Store always redacts. */
  readonly envelope: Record<string, unknown>;
  readonly sourceFile?: string | null;
  readonly domainEventCount: number;
}

export interface ResolveRawResult {
  readonly row: RawEventRow;
  readonly domainEventId: string | null;
}

export interface RawEventStoreShape {
  readonly append: (input: AppendRawEventInput) => Effect.Effect<RawEventRow, DbError>;
  readonly get: (id: string) => Effect.Effect<RawEventRow, NotFound>;
  /**
   * Resolve raw for a domain event id or a raw id (GET /api/events/:id/raw).
   * 1. If domain exists: try unique [correlation_id, id] for a raw PK hit.
   * 2. Else if raw exists: return raw with domain_event_id null.
   * 3. Else NotFound.
   */
  readonly resolveForEventId: (
    eventOrRawId: string,
  ) => Effect.Effect<ResolveRawResult, NotFound>;
}

export class RawEventStore extends Context.Tag("@cognit/db/RawEventStore")<
  RawEventStore,
  RawEventStoreShape
>() {}

const SELECT_RAW = `SELECT id, project_id, session_id, type, version,
  actor_name, actor_type, envelope_json, source_tool, source_command,
  domain_event_count, source_file, created_at
  FROM raw_events WHERE id = ?`;

const fetchRaw = (
  handle: { get: <T>(sql: string, params?: unknown[]) => T | undefined },
  id: string,
): RawEventRow | undefined => handle.get<RawEventRow>(SELECT_RAW, [id]);

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/** Denormalized source_tool / source_command from redacted wire. */
export const denormalizeSource = (
  wire: Record<string, unknown>,
): { sourceTool: string | null; sourceCommand: string | null } => {
  const source = asRecord(wire["source"]);
  const payload = asRecord(wire["payload"]);
  const toolFromSource =
    source && typeof source["tool"] === "string" ? source["tool"] : null;
  const toolFromPayload =
    payload && typeof payload["tool"] === "string" ? payload["tool"] : null;
  const cmd =
    source && typeof source["command"] === "string" ? source["command"] : null;
  return {
    sourceTool: toolFromSource ?? toolFromPayload,
    sourceCommand: cmd,
  };
};

export const RawEventStoreLive: Layer.Layer<
  RawEventStore,
  never,
  DbConnection | Redactor | Logger
> = Layer.effect(
  RawEventStore,
  Effect.gen(function* () {
    const { handle } = yield* DbConnection;
    const redactor = yield* Redactor;
    const logger = yield* Logger;

    const append = (input: AppendRawEventInput): Effect.Effect<RawEventRow, DbError> =>
      Effect.gen(function* () {
        const redacted = redactor.redactValue(input.envelope) as Record<string, unknown>;
        const envelopeJson = JSON.stringify(redacted);
        if (envelopeJson.length > ONE_MIB) {
          yield* logger.log(
            "warning",
            { id: input.id, bytes: envelopeJson.length },
            "raw_events: envelope_json exceeds 1MiB",
          );
        }
        const { sourceTool, sourceCommand } = denormalizeSource(redacted);
        const createdAt = nowIso();
        const sourceFile = input.sourceFile ?? null;

        yield* trySync(
          () => {
            handle.run(
              `INSERT INTO raw_events (
                id, project_id, session_id, type, version,
                actor_name, actor_type, envelope_json,
                source_tool, source_command, domain_event_count,
                source_file, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                domain_event_count = excluded.domain_event_count,
                source_file = COALESCE(excluded.source_file, raw_events.source_file)`,
              [
                input.id,
                input.projectId,
                input.sessionId,
                input.type,
                input.version,
                input.actorName,
                input.actorType,
                envelopeJson,
                sourceTool,
                sourceCommand,
                input.domainEventCount,
                sourceFile,
                createdAt,
              ],
            );
          },
          (e) => new DbError({ message: `raw_events.append failed: ${String(e)}`, cause: e }),
        );

        const row = yield* trySync(
          () => fetchRaw(handle, input.id),
          (e) => new DbError({ message: `raw_events.append re-fetch failed: ${String(e)}`, cause: e }),
        );
        if (row === undefined) {
          return yield* Effect.fail(
            new DbError({ message: `raw_events.append: row missing after upsert for ${input.id}` }),
          );
        }
        return row;
      });

    const get = (id: string): Effect.Effect<RawEventRow, NotFound> =>
      Effect.sync(() => fetchRaw(handle, id)).pipe(
        Effect.flatMap((row) =>
          row === undefined
            ? Effect.fail(new NotFound({ entity: "raw_event", id }))
            : Effect.succeed(row),
        ),
      );

    const resolveForEventId = (
      eventOrRawId: string,
    ): Effect.Effect<ResolveRawResult, NotFound> =>
      Effect.gen(function* () {
        const domain = handle.get<{ id: string; correlation_id: string | null }>(
          "SELECT id, correlation_id FROM events WHERE id = ?",
          [eventOrRawId],
        );
        if (domain !== undefined) {
          const candidates: string[] = [];
          if (domain.correlation_id != null && domain.correlation_id.length > 0) {
            candidates.push(domain.correlation_id);
          }
          if (!candidates.includes(domain.id)) {
            candidates.push(domain.id);
          }
          for (const c of candidates) {
            const raw = fetchRaw(handle, c);
            if (raw !== undefined) {
              return { row: raw, domainEventId: eventOrRawId };
            }
          }
          return yield* Effect.fail(
            new NotFound({ entity: "raw_event", id: eventOrRawId }),
          );
        }

        const rawOnly = fetchRaw(handle, eventOrRawId);
        if (rawOnly !== undefined) {
          return { row: rawOnly, domainEventId: null };
        }
        return yield* Effect.fail(new NotFound({ entity: "raw_event", id: eventOrRawId }));
      });

    return { append, get, resolveForEventId };
  }),
);
