/**
 * apps/server/src/routes/events.ts — event HTTP surface.
 *
 *   GET  /sessions/:id/events?limit=N      session-scoped recent
 *   GET  /events/stream                     SSE live mode (5.2)
 *   GET  /events/feed?limit=N               project-wide tail
 *   GET  /events?session=&type=&actor=&since=&limit=&cursor=
 *                                          filtered + ULID-cursor pagination
 *   POST /events                            funneled through appendEvent
 *
 * POST funnels through `SessionService.appendEvent` so the
 * redaction boundary + the constraint chokepoint (phase 3c)
 * stay in effect. The same path the CLI uses. We never write
 * via a parallel code path.
 *
 * On a successful POST, the bus receives the inserted `EventRow`
 * so live SSE subscribers see the new event without polling.
 *
 * Errors use the v1 ApiError envelope (`./api-error.ts`). The
 * request_id stamped by `requestIdMiddleware` is echoed on every
 * error response and in the `x-request-id` header.
 */
import { Effect } from "effect";
import { Hono } from "hono";
import {
  CURRENT_VERSION,
  DbConnection,
  DbError,
  EventStore,
  NotFound,
  RawEventStore,
  SessionService,
  UnknownEventType,
  type EventRow,
  type ActorType,
  type RawEventRow,
} from "@cognit/db";
import { envelope } from "../envelope.js";
import { apiErrorResponse } from "../api-error.js";
import { sseHandler } from "../sse.js";
import { listRecentForSessionE, listRecentAcrossProjectE } from "../event-queries.js";
import type { ServerRuntime } from "./sessions.js";

const VALID_ACTOR_TYPES = new Set<ActorType>(["human", "worker", "system"]);

/**
 * Crockford ULID: 26 base32 chars from `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
 * Lenient check for routing purposes — full Crockford grammar is
 * out of scope. We require 26 chars drawn from the encoding alphabet.
 */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface PostEventBody {
  readonly session_id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly actor: string;
  readonly id?: string;
  readonly source?: {
    readonly tool: string;
    readonly command: string;
    readonly filePath?: string;
  };
}

const isString = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const parseBody = (
  raw: unknown,
): { ok: true; value: PostEventBody } | { ok: false; error: string } => {
  if (!isObject(raw)) return { ok: false, error: "body must be a JSON object" };
  if (!isString(raw.session_id))
    return { ok: false, error: "session_id must be a non-empty string" };
  if (!isString(raw.type)) return { ok: false, error: "type must be a non-empty string" };
  if (!isString(raw.actor)) return { ok: false, error: "actor must be a non-empty string" };
  let source:
    | { readonly tool: string; readonly command: string; readonly filePath?: string }
    | undefined;
  if (raw.source !== undefined) {
    if (!isObject(raw.source)) return { ok: false, error: "source must be an object" };
    if (!isString(raw.source.tool)) return { ok: false, error: "source.tool must be a string" };
    if (!isString(raw.source.command))
      return { ok: false, error: "source.command must be a string" };
    const filePath = isString(raw.source.filePath) ? raw.source.filePath : undefined;
    source =
      filePath !== undefined
        ? { tool: raw.source.tool, command: raw.source.command, filePath }
        : { tool: raw.source.tool, command: raw.source.command };
  }
  const id = isString(raw.id) ? raw.id : undefined;
  const base = {
    session_id: raw.session_id,
    type: raw.type,
    payload: raw.payload,
    actor: raw.actor,
  };
  return {
    ok: true,
    value: {
      ...base,
      ...(id !== undefined ? { id } : {}),
      ...(source !== undefined ? { source } : {}),
    },
  };
};

export interface EventsRouteDeps {
  readonly runtime: ServerRuntime;
  /** Project id for project-wide queries. */
  readonly projectId: string;
}

/** Parse "name:type" into typed actor. Returns null on invalid type. */
const parseActorString = (raw: string): { name: string; type: ActorType } | null => {
  const idx = raw.lastIndexOf(":");
  if (idx < 0) return { name: raw, type: "system" };
  const name = raw.slice(0, idx) || "anon";
  const type = raw.slice(idx + 1);
  if (!VALID_ACTOR_TYPES.has(type as ActorType)) return null;
  return { name, type: type as ActorType };
};

export const registerEventsRoutes = (app: Hono, deps: EventsRouteDeps): void => {
  const { runtime, projectId } = deps;

  // GET /sessions/:id/events?limit=N
  app.get("/api/sessions/:id/events", async (c) => {
    const sessionId = c.req.param("id");
    const limit = Math.min(Number(c.req.query("limit") ?? "100"), 1000);
    const events = await runtime.runPromise(
      listRecentForSessionE(sessionId, limit) as Effect.Effect<
        ReadonlyArray<EventRow>,
        never,
        never
      >,
    );
    return c.json(envelope("events.list", { session_id: sessionId, events }));
  });

  // GET /events/stream  (SSE) — default replay 1000, heartbeat 15s, retry 5000
  app.get("/api/events/stream", sseHandler(runtime, { replayLimit: 1000, projectId }));

  // GET /events/feed  — project-wide tail (read-only)
  app.get("/api/events/feed", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 500);
    const events = await runtime.runPromise(
      listRecentAcrossProjectE(projectId, limit) as Effect.Effect<
        ReadonlyArray<EventRow>,
        never,
        never
      >,
    );
    return c.json(envelope("events.feed", { events }));
  });

  // GET /events — filtered + ULID-cursor paginated.
  // Filters:
  //   session    session_id (exact match)
  //   type[]     event type (repeatable: ?type=a&type=b)
  //   actor      actor name (exact match against actors.name)
  //   since      ULID; events with id > since (strict ULID lex order)
  //   cursor     ULID; same predicate as `since` (mutually exclusive
  //              with `since`; UI uses `cursor` for paging, `since`
  //              for "since this point in time")
  //   limit      1..500, default 100
  app.get("/api/events", async (c) => {
    const sessionQ = c.req.query("session");
    const typeQ = c.req.queries("type");
    const actorQ = c.req.query("actor");
    const sinceQ = c.req.query("since");
    const cursorQ = c.req.query("cursor");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 100 : Math.max(1, Math.min(500, Number(limitRaw)));

    if (sinceQ !== undefined && !ULID_RE.test(sinceQ)) {
      return apiErrorResponse(c, "bad_request", "`since` must be a 26-char ULID");
    }
    if (cursorQ !== undefined && !ULID_RE.test(cursorQ)) {
      return apiErrorResponse(c, "bad_request", "`cursor` must be a 26-char ULID");
    }
    if (sinceQ !== undefined && cursorQ !== undefined) {
      return apiErrorResponse(c, "bad_request", "`since` and `cursor` are mutually exclusive");
    }

    const afterId = sinceQ ?? cursorQ ?? null;

    type ListResult = ReadonlyArray<EventRow>;
    const listProgram: Effect.Effect<ListResult, unknown, DbConnection> = Effect.gen(function* () {
      const conn = yield* DbConnection;
      const where: string[] = ["project_id = ?"];
      const params: Array<string | number> = [projectId];
      if (sessionQ !== undefined) {
        where.push("session_id = ?");
        params.push(sessionQ);
      }
      if (typeQ !== undefined && typeQ.length > 0) {
        const placeholders = typeQ.map(() => "?").join(",");
        where.push(`type IN (${placeholders})`);
        params.push(...typeQ);
      }
      if (actorQ !== undefined) {
        // Join to actors so the filter is by actor name (not actor_id).
        where.push("actor_id = (SELECT id FROM actors WHERE name = ?)");
        params.push(actorQ);
      }
      if (afterId !== null) {
        where.push("id > ?");
        params.push(afterId);
      }
      // Fetch limit+1 to detect next page.
      params.push(limit + 1);
      const sql = `SELECT * FROM events
                   WHERE ${where.join(" AND ")}
                   ORDER BY id ASC
                   LIMIT ?`;
      return conn.handle.all<EventRow>(sql, params);
    });
    const listExit = await runtime.runPromiseExit(
      listProgram as unknown as Effect.Effect<ListResult, unknown, never>,
    );
    if (listExit._tag === "Failure") {
      return apiErrorResponse(c, "internal", "events.list: query failed");
    }
    const rows = (listExit as { value: ListResult }).value;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const next_cursor = hasMore ? page[page.length - 1]!.id : null;
    return c.json(
      envelope("events.list", {
        events: page,
        next_cursor,
      }),
    );
  });

  // POST /events
  app.post("/api/events", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e) {
      return apiErrorResponse(c, "bad_request", `body is not JSON: ${(e as Error).message}`);
    }
    const parsed = parseBody(body);
    if (!parsed.ok) {
      return apiErrorResponse(c, "bad_request", parsed.error);
    }
    const actor = parseActorString(parsed.value.actor);
    if (!actor) {
      return apiErrorResponse(
        c,
        "bad_request",
        "actor must be 'name:type' with type human|worker|system",
      );
    }

    const program = Effect.gen(function* () {
      const session = yield* SessionService;
      // §1.5: funnel through the unified `ingest` entry so the server
      // shares decode + validation with the inbox path. lazyCreate is
      // false — the server requires a real session_id; it does not
      // bootstrap one (unlike the inbox). Bus publish + snapshot happen
      // inside `appendEvent`; do not publish here.
      return yield* session.ingest({
        envelope: {
          type: parsed.value.type,
          version: CURRENT_VERSION,
          session_id: parsed.value.session_id,
          actor_name: actor.name,
          actor_type: actor.type,
          payload: parsed.value.payload,
          ...(parsed.value.id !== undefined ? { id: parsed.value.id } : {}),
          ...(parsed.value.source !== undefined ? { source: parsed.value.source } : {}),
        },
        projectId,
        lazyCreate: false,
      });
    });

    type Err = UnknownEventType | DbError | Error;
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<{ event: EventRow; snapshotTaken: boolean }, Err, never>,
    );
    if (exit._tag === "Failure") {
      const cause = (exit as { cause: unknown }).cause;
      const err = JSON.stringify(cause);
      if (err.includes("UnknownEventType") || err.includes("UnknownEventVersion")) {
        return apiErrorResponse(c, "unknown_event_type", `event type not in catalog`);
      }
      if (
        err.includes("ValidationFailure") ||
        err.includes("PayloadDecodeFailure") ||
        err.includes("EnvelopeDecodeFailure") ||
        err.includes("UnknownPayloadType")
      ) {
        return apiErrorResponse(c, "validation_failed", "envelope or payload failed validation");
      }
      if (err.includes("SessionClosed") || err.includes("UnknownSession")) {
        return apiErrorResponse(c, "session_unavailable", "session is not accepting events");
      }
      if (err.includes("ConstraintViolation")) {
        return apiErrorResponse(c, "constraint_violation", "constraint engine rejected the event");
      }
      return apiErrorResponse(c, "internal", "event.append failed");
    }
    const value = (exit as { value: { event: EventRow; snapshotTaken: boolean } }).value;
    return c.json(
      envelope("event.appended", {
        event: value.event,
        snapshot_taken: value.snapshotTaken,
      }),
      201,
    );
  });

  // D-M6-00: GET /api/events/:id/raw — must register before bare :id
  app.get("/api/events/:id/raw", async (c) => {
    const id = c.req.param("id");
    if (!ULID_RE.test(id)) {
      return apiErrorResponse(c, "bad_request", "`id` must be a 26-char ULID");
    }
    const program = Effect.gen(function* () {
      const rawStore = yield* RawEventStore;
      return yield* rawStore.resolveForEventId(id);
    });
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<
        { row: RawEventRow; domainEventId: string | null },
        NotFound,
        never
      >,
    );
    if (exit._tag === "Failure") {
      return apiErrorResponse(c, "not_found", "no raw envelope for event");
    }
    const { row, domainEventId } = (
      exit as { value: { row: RawEventRow; domainEventId: string | null } }
    ).value;
    let parsedEnvelope: unknown = {};
    try {
      parsedEnvelope = JSON.parse(row.envelope_json);
    } catch {
      parsedEnvelope = {};
    }
    return c.json(
      envelope("events.raw", {
        raw_event: {
          id: row.id,
          project_id: row.project_id,
          session_id: row.session_id,
          type: row.type,
          version: row.version,
          actor_name: row.actor_name,
          actor_type: row.actor_type,
          domain_event_count: row.domain_event_count,
          created_at: row.created_at,
          source_tool: row.source_tool,
          source_command: row.source_command,
          envelope: parsedEnvelope,
        },
        domain_event_id: domainEventId,
      }),
    );
  });

  // D-M6-00: GET /api/events/:id — domain event by id
  app.get("/api/events/:id", async (c) => {
    const id = c.req.param("id");
    if (!ULID_RE.test(id)) {
      return apiErrorResponse(c, "bad_request", "`id` must be a 26-char ULID");
    }
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      return yield* store.get(id);
    });
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<EventRow, NotFound, never>,
    );
    if (exit._tag === "Failure") {
      return apiErrorResponse(c, "not_found", "event not found");
    }
    const event = (exit as { value: EventRow }).value;
    return c.json(envelope("events.get", { event }));
  });
};
