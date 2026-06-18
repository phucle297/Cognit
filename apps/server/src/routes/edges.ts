/**
 * apps/server/src/routes/edges.ts — session-scoped edge routes.
 *
 *   GET  /sessions/:id/edges?edge_type&from&to&cursor&limit
 *   POST /sessions/:id/edges
 *
 * `POST` validates against the EDGE_CATALOG (plan.xml §edge_types).
 * The from/to entity types must match the catalog rule for that
 * `edge_type`; unknown types and mismatched entities yield 400.
 *
 * Idempotency: when `client_edge_id` is supplied, it's used as the
 * underlying event id. If the same id is posted twice, the second
 * call returns the existing row (HTTP 200, not 201) — no duplicate
 * event, no double publish on the bus.
 *
 * Mutations flow through `SessionService.appendEvent` so the
 * redaction boundary, the constraint chokepoint, and the single
 * bus publish (phase 5.1) stay in effect.
 */
import { Effect } from "effect";
import { Hono } from "hono";
import {
  DbError,
  SessionService,
  UnknownEventType,
  type ActorType,
  type EventRow,
} from "@cognit/db";
import { envelope } from "../envelope.js";
import { apiErrorResponse } from "../api-error.js";
import type { ServerRuntime } from "./sessions.js";

/**
 * Edge type catalog (plan.xml §edge_types). The `from` / `to` arrays
 * list the entity types allowed at each end. `"any"` matches every
 * known entity type at validation time.
 *
 * The shape is the single source of truth for edge validation
 * here and in `apps/server/test/state-graph-edges.test.ts` — keep
 * them in sync.
 */
const EDGE_CATALOG: Readonly<Record<string, { readonly from: ReadonlyArray<string>; readonly to: ReadonlyArray<string> }>> = {
  tests:        { from: ["experiment"],   to: ["hypothesis"] },
  supports:     { from: ["finding", "conclusion"], to: ["hypothesis"] },
  contradicts:  { from: ["finding", "conclusion"], to: ["hypothesis"] },
  supersedes:   { from: ["hypothesis", "decision"], to: ["hypothesis", "decision"] },
  caused:       { from: ["decision"],     to: ["experiment"] },
  based_on:     { from: ["decision"],     to: ["conclusion"] },
  verified_by:  { from: ["conclusion"],   to: ["verification"] },
  belongs_to:   { from: ["hypothesis"],   to: ["theory"] },
  derived_from: { from: ["finding"],      to: ["observation", "finding"] },
  references:   { from: ["any"],          to: ["artifact"] },
} as const;

const VALID_ACTOR_TYPES = new Set<ActorType>(["human", "worker", "system"]);

const isString = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const parseActor = (
  raw: unknown,
): { ok: true; value: { name: string; type: ActorType } } | { ok: false; error: string } => {
  if (!isObject(raw)) return { ok: false, error: "actor must be an object" };
  if (!isString(raw.name)) return { ok: false, error: "actor.name must be a non-empty string" };
  if (!isString(raw.type) || !VALID_ACTOR_TYPES.has(raw.type as ActorType)) {
    return { ok: false, error: "actor.type must be human|worker|system" };
  }
  return { ok: true, value: { name: raw.name, type: raw.type as ActorType } };
};

const parseEndpoint = (
  raw: unknown,
  field: string,
): { ok: true; value: { entity_type: string; entity_id: string } } | { ok: false; error: string } => {
  if (!isObject(raw)) return { ok: false, error: `${field} must be an object` };
  if (!isString(raw.entity_type)) return { ok: false, error: `${field}.entity_type must be a non-empty string` };
  if (!isString(raw.entity_id)) return { ok: false, error: `${field}.entity_id must be a non-empty string` };
  return { ok: true, value: { entity_type: raw.entity_type, entity_id: raw.entity_id } };
};

const matchesCatalog = (
  allowed: ReadonlyArray<string>,
  actual: string,
): boolean => allowed.includes("any") || allowed.includes(actual);

export interface EdgesRouteDeps {
  readonly runtime: ServerRuntime;
  /** Project id used for cross-session scoping where relevant. */
  readonly projectId: string;
}

export const registerEdgesRoutes = (app: Hono, deps: EdgesRouteDeps): void => {
  const { runtime } = deps;

  // GET /sessions/:id/edges
  // Filters: edge_type, from (entity_type:entity_id), to (same), cursor (ULID event_id), limit (1..500, default 100).
  app.get("/api/sessions/:id/edges", async (c) => {
    const sessionId = c.req.param("id");
    const edgeType = c.req.query("edge_type");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const cursor = c.req.query("cursor");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 100 : Math.max(1, Math.min(500, Number(limitRaw)));

    const program = Effect.gen(function* () {
      const svc = yield* SessionService;
      const { state } = yield* svc.show(sessionId);
      return state.edges;
    });
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<ReadonlyArray<import("@cognit/core/state").EdgeState>, never, never>,
    );
    if (exit._tag === "Failure") {
      const cause = (exit as { cause: unknown }).cause;
      const err = JSON.stringify(cause);
      if (err.includes("UnknownSession")) {
        return apiErrorResponse(c, "not_found", `session '${sessionId}' not found`, { id: sessionId });
      }
      return apiErrorResponse(c, "internal", "session.edges: query failed");
    }
    const all = (exit as { value: ReadonlyArray<import("@cognit/core/state").EdgeState> }).value;

    let rows = all;
    if (edgeType !== undefined) rows = rows.filter((e) => e.edge_type === edgeType);
    if (from !== undefined) {
      const [t, i] = from.split(":", 2);
      if (!t || !i) {
        return apiErrorResponse(c, "bad_request", "`from` must be `entity_type:entity_id`");
      }
      rows = rows.filter((e) => e.from_entity_type === t && e.from_entity_id === i);
    }
    if (to !== undefined) {
      const [t, i] = to.split(":", 2);
      if (!t || !i) {
        return apiErrorResponse(c, "bad_request", "`to` must be `entity_type:entity_id`");
      }
      rows = rows.filter((e) => e.to_entity_type === t && e.to_entity_id === i);
    }
    if (cursor !== undefined) {
      // ULID cursor: edges strictly after the cursor in event_id order
      // (lexicographic ULID order matches time order).
      rows = rows.filter((e) => e.id > cursor);
    }
    const page = rows.slice(0, limit);
    const next_cursor = rows.length > limit ? page[page.length - 1]!.id : null;
    return c.json(
      envelope("session.edges", {
        session_id: sessionId,
        edges: page,
        next_cursor,
      }),
    );
  });

  // POST /sessions/:id/edges
  // Body shape:
  //   {
  //     edge_type: string,
  //     from: { entity_type, entity_id },
  //     to:   { entity_type, entity_id },
  //     actor: { name, type },
  //     client_edge_id?: string,   // idempotency
  //     confidence?: number
  //   }
  app.post("/api/sessions/:id/edges", async (c) => {
    const sessionId = c.req.param("id");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (e) {
      return apiErrorResponse(
        c,
        "bad_request",
        `body is not JSON: ${(e as Error).message}`,
      );
    }
    if (!isObject(raw)) {
      return apiErrorResponse(c, "bad_request", "body must be a JSON object");
    }
    if (!isString(raw.edge_type)) {
      return apiErrorResponse(c, "bad_request", "edge_type must be a non-empty string");
    }
    const rule = EDGE_CATALOG[raw.edge_type];
    if (rule === undefined) {
      return apiErrorResponse(
        c,
        "validation_failed",
        `edge_type '${raw.edge_type}' is not in the v0.1 catalog`,
      );
    }
    const fromParsed = parseEndpoint(raw.from, "from");
    if (!fromParsed.ok) {
      return apiErrorResponse(c, "bad_request", fromParsed.error);
    }
    const toParsed = parseEndpoint(raw.to, "to");
    if (!toParsed.ok) {
      return apiErrorResponse(c, "bad_request", toParsed.error);
    }
    if (!matchesCatalog(rule.from, fromParsed.value.entity_type)) {
      return apiErrorResponse(
        c,
        "validation_failed",
        `edge_type '${raw.edge_type}' does not accept from=${fromParsed.value.entity_type}`,
      );
    }
    if (!matchesCatalog(rule.to, toParsed.value.entity_type)) {
      return apiErrorResponse(
        c,
        "validation_failed",
        `edge_type '${raw.edge_type}' does not accept to=${toParsed.value.entity_type}`,
      );
    }
    const actor = parseActor(raw.actor);
    if (!actor.ok) {
      return apiErrorResponse(c, "bad_request", actor.error);
    }
    const clientEdgeId = isString(raw.client_edge_id) ? raw.client_edge_id : undefined;
    const confidence = typeof raw.confidence === "number" ? raw.confidence : undefined;

    // Idempotency pre-check: if client_edge_id was already used to
    // create an edge in this session, return that edge at 200 with
    // replay:true (no second append, no double bus publish).
    // EventStore.append also swallows DuplicateEventId internally and
    // re-fetches the row, so without this pre-check we could not
    // distinguish create-vs-replay in the response status.
    if (clientEdgeId !== undefined) {
      const lookupProgram = Effect.gen(function* () {
        const svc = yield* SessionService;
        const { state } = yield* svc.show(sessionId);
        return state.edges.find((e) => e.id === clientEdgeId) ?? null;
      });
      const lookupExit = await runtime.runPromiseExit(
        lookupProgram as Effect.Effect<unknown, unknown, never>,
      );
      if (lookupExit._tag === "Success") {
        const existing = (lookupExit as { value: unknown }).value;
        if (existing !== null) {
          return c.json(envelope("edge.created", { edge: existing, replay: true }));
        }
      }
      // Lookup failure: fall through to the create path. The append
      // will still race-safely resolve via EventStore's catchTag.
    }

    const program = Effect.gen(function* () {
      const svc = yield* SessionService;
      const { event, snapshotTaken } = yield* svc.appendEvent({
        sessionId,
        type: "edge_created",
        payload: {
          edge_type: raw.edge_type,
          from_entity_type: fromParsed.value.entity_type,
          from_entity_id: fromParsed.value.entity_id,
          to_entity_type: toParsed.value.entity_type,
          to_entity_id: toParsed.value.entity_id,
        },
        actor: actor.value,
        ...(clientEdgeId !== undefined ? { id: clientEdgeId } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
      });
      return { event, snapshotTaken };
    });

    type Err = UnknownEventType | DbError | Error;
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<{ event: EventRow; snapshotTaken: boolean }, Err, never>,
    );
    if (exit._tag === "Failure") {
      const cause = (exit as { cause: unknown }).cause;
      const err = JSON.stringify(cause);
      if (err.includes("UnknownEventType")) {
        return apiErrorResponse(c, "unknown_event_type", "event type not in catalog");
      }
      if (err.includes("SessionClosed") || err.includes("UnknownSession")) {
        return apiErrorResponse(c, "session_unavailable", "session is not accepting events");
      }
      if (err.includes("ConstraintViolation")) {
        return apiErrorResponse(c, "constraint_violation", "constraint engine rejected the edge");
      }
      return apiErrorResponse(c, "internal", "edge.created: append failed");
    }

    const value = (exit as { value: { event: EventRow; snapshotTaken: boolean } }).value;
    const edge = {
      id: value.event.id,
      edge_type: raw.edge_type,
      from_entity_type: fromParsed.value.entity_type,
      from_entity_id: fromParsed.value.entity_id,
      to_entity_type: toParsed.value.entity_type,
      to_entity_id: toParsed.value.entity_id,
      created_at: value.event.created_at,
      event_id: value.event.id,
    };
    return c.json(
      envelope("edge.created", {
        edge,
        snapshot_taken: value.snapshotTaken,
        replay: false,
      }),
      201,
    );
  });
};