/**
 * apps/server/src/routes/events.ts — `GET /sessions/:id/events`,
 * `GET /events/stream`, `POST /events`.
 *
 * POST /events funnels through `SessionService.appendEvent` so
 * the redaction boundary + the constraint chokepoint (phase 3c)
 * stay in effect. The same path the CLI uses. We never write
 * via a parallel code path.
 *
 * The handler is wired to the project root via `runtime.runPromise`.
 * The runtime provides `SessionService`, `EventStore`, `DbConnection`,
 * `EventBus`, and the `Logger`.
 *
 * On a successful POST, the bus receives the inserted `EventRow`
 * so live SSE subscribers see the new event without polling.
 */
import { Effect } from "effect";
import { Hono } from "hono";
import {
  DbError,
  SessionService,
  UnknownEventType,
  type EventRow,
  type ActorType,
} from "@cognit/db";
import { envelope } from "../envelope.js";
import { sseHandler } from "../sse.js";
import { listRecentForSessionE, listRecentAcrossProjectE } from "../event-queries.js";
import type { ServerRuntime } from "./sessions.js";

const VALID_ACTOR_TYPES = new Set<ActorType>(["human", "worker", "system"]);

/** Minimal hand-rolled shape check; the heavy validation lives in `EventStore.append`. */
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

const parseBody = (raw: unknown): { ok: true; value: PostEventBody } | { ok: false; error: string } => {
  if (!isObject(raw)) return { ok: false, error: "body must be a JSON object" };
  if (!isString(raw.session_id)) return { ok: false, error: "session_id must be a non-empty string" };
  if (!isString(raw.type)) return { ok: false, error: "type must be a non-empty string" };
  if (!isString(raw.actor)) return { ok: false, error: "actor must be a non-empty string" };
  let source: { readonly tool: string; readonly command: string; readonly filePath?: string } | undefined;
  if (raw.source !== undefined) {
    if (!isObject(raw.source)) return { ok: false, error: "source must be an object" };
    if (!isString(raw.source.tool)) return { ok: false, error: "source.tool must be a string" };
    if (!isString(raw.source.command)) return { ok: false, error: "source.command must be a string" };
    const filePath = isString(raw.source.filePath) ? raw.source.filePath : undefined;
    source = filePath !== undefined
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
  app.get("/sessions/:id/events", async (c) => {
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
  app.get("/events/stream", sseHandler(runtime, { replayLimit: 1000, projectId }));

  // GET /events/feed  — project-wide tail (read-only)
  app.get("/events/feed", async (c) => {
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

  // POST /events
  app.post("/events", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e) {
      return c.json(
        { error: "bad_request", message: `body is not JSON: ${(e as Error).message}` },
        400,
      );
    }
    const parsed = parseBody(body);
    if (!parsed.ok) {
      return c.json({ error: "bad_request", message: parsed.error }, 400);
    }
    const actor = parseActorString(parsed.value.actor);
    if (!actor) {
      return c.json(
        { error: "bad_request", message: "actor must be 'name:type' with type human|worker|system" },
        400,
      );
    }

    const program = Effect.gen(function* () {
      const session = yield* SessionService;
      const r = yield* session.appendEvent({
        sessionId: parsed.value.session_id,
        type: parsed.value.type,
        payload: parsed.value.payload,
        actor,
        ...(parsed.value.id !== undefined ? { id: parsed.value.id } : {}),
        ...(parsed.value.source !== undefined ? { source: parsed.value.source } : {}),
      });
      // Bus publish happens inside SessionService.appendEvent
      // (phase 5.1 chokepoint). Do NOT publish here — duplicates
      // would double-deliver to SSE subscribers.
      return r;
    });

    type Err = UnknownEventType | DbError | Error;
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<{ event: EventRow; snapshotTaken: boolean }, Err, never>,
    );
    if (exit._tag === "Failure") {
      const cause = (exit as { cause: unknown }).cause;
      const err = JSON.stringify(cause);
      if (err.includes("UnknownEventType")) {
        return c.json({ error: "unknown_event_type", cause }, 400);
      }
      if (err.includes("SessionClosed") || err.includes("UnknownSession")) {
        return c.json({ error: "session_unavailable", cause }, 409);
      }
      if (err.includes("ConstraintViolation")) {
        return c.json({ error: "constraint_violation", cause }, 422);
      }
      return c.json({ error: "internal", cause }, 500);
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
};

