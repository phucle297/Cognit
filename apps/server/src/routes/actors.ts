/**
 * apps/server/src/routes/actors.ts — actor registry HTTP surface.
 *
 *   GET  /actors?type&name_contains&cursor&limit
 *   POST /actors
 *
 * Trust-score resolution chain (POST):
 *   body.trust_score → DEFAULT_TRUST_BY_TYPE[type] → 0.5
 *
 * `actor_registered` audit event is emitted ONLY when the caller
 * supplies `session_id` in the body — events.session_id is NOT NULL
 * at the schema level. Bare identity registration (no session) just
 * inserts the row; the audit event will fire later when the actor
 * is first observed in a session via POST /events.
 */
import { Effect } from "effect";
import { Hono } from "hono";
import {
  DbConnection,
  SessionService,
  Uuid,
  type ActorType,
  type EventRow,
} from "@cognit/db";
import { envelope } from "../envelope.js";
import type { ServerRuntime } from "./sessions.js";

const VALID_ACTOR_TYPES: ReadonlyArray<ActorType> = ["human", "worker", "system"];

const DEFAULT_TRUST_BY_TYPE: Readonly<Record<ActorType, number>> = {
  human: 0.9,
  worker: 0.6,
  system: 1.0,
};

const DEFAULT_TRUST_FALLBACK = 0.5;

const isString = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

interface ActorRow {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly trust_score: number;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

export interface ActorsRouteDeps {
  readonly runtime: ServerRuntime;
  readonly projectId: string;
}

export const registerActorsRoutes = (app: Hono, deps: ActorsRouteDeps): void => {
  const { runtime, projectId } = deps;

  // GET /actors
  app.get("/actors", async (c) => {
    const type = c.req.query("type");
    const nameContains = c.req.query("name_contains");
    const cursor = c.req.query("cursor");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 100 : Math.max(1, Math.min(500, Number(limitRaw)));

    const program: Effect.Effect<ReadonlyArray<ActorRow>, never, DbConnection> = Effect.gen(function* () {
      const conn = yield* DbConnection;
      return conn.handle.all<ActorRow>(
        `SELECT id, type, name, trust_score, first_seen_at, last_seen_at
         FROM actors
         ORDER BY name ASC`,
      );
    });
    const exit = await runtime.runPromiseExit(
      program as unknown as Effect.Effect<ReadonlyArray<ActorRow>, unknown, never>,
    );
    if (exit._tag === "Failure") {
      const cause = (exit as { cause: unknown }).cause;
      return c.json({ error: "internal", cause }, 500);
    }
    let rows = (exit as { value: ReadonlyArray<ActorRow> }).value;

    if (type !== undefined) {
      rows = rows.filter((r) => r.type === type);
    }
    if (nameContains !== undefined) {
      const needle = nameContains.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(needle));
    }
    if (cursor !== undefined) {
      rows = rows.filter((r) => r.name > cursor);
    }
    const page = rows.slice(0, limit);
    const next_cursor = rows.length > limit ? page[page.length - 1]!.name : null;

    return c.json(
      envelope("actors.list", {
        actors: page,
        next_cursor,
        project_id: projectId,
      }),
    );
  });

  // POST /actors
  app.post("/actors", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (e) {
      return c.json(
        { error: "bad_request", message: `body is not JSON: ${(e as Error).message}` },
        400,
      );
    }
    if (!isObject(raw)) {
      return c.json({ error: "bad_request", message: "body must be a JSON object" }, 400);
    }
    const name = isString(raw.name) ? raw.name : null;
    if (name === null || name.length === 0 || name.length > 120) {
      return c.json(
        { error: "bad_request", message: "name must be a non-empty string up to 120 chars" },
        400,
      );
    }
    const type = isString(raw.type) && VALID_ACTOR_TYPES.includes(raw.type as ActorType) ? raw.type : null;
    if (type === null) {
      return c.json(
        { error: "bad_request", message: `type must be one of ${VALID_ACTOR_TYPES.join("|")}` },
        400,
      );
    }
    const trustBody = typeof raw.trust_score === "number" ? raw.trust_score : undefined;
    if (trustBody !== undefined && (trustBody < 0 || trustBody > 1)) {
      return c.json(
        { error: "bad_request", message: "trust_score must be in [0, 1]" },
        400,
      );
    }
    const sessionId = isString(raw.session_id) ? raw.session_id : undefined;

    // 1. Duplicate check by name → 409
    const lookupProgram: Effect.Effect<ActorRow | null, never, DbConnection> = Effect.gen(function* () {
      const conn = yield* DbConnection;
      return conn.handle.get<ActorRow>(
        "SELECT id, type, name, trust_score, first_seen_at, last_seen_at FROM actors WHERE name = ?",
        [name],
      ) ?? null;
    });
    const lookupExit = await runtime.runPromiseExit(
      lookupProgram as unknown as Effect.Effect<ActorRow | null, unknown, never>,
    );
    if (lookupExit._tag === "Failure") {
      const cause = (lookupExit as { cause: unknown }).cause;
      return c.json({ error: "internal", cause }, 500);
    }
    const existing = (lookupExit as { value: ActorRow | null }).value;
    if (existing !== null) {
      return c.json(
        { error: "conflict", message: `actor with name '${name}' already exists`, name },
        409,
      );
    }

    // 2. Resolve trust_score: body > DEFAULT[type] > 0.5
    const trustScore =
      trustBody ?? DEFAULT_TRUST_BY_TYPE[type as ActorType] ?? DEFAULT_TRUST_FALLBACK;

    // 3. INSERT actor row
    type Inserted = {
      readonly id: string;
      readonly trust_score: number;
      readonly first_seen_at: string;
      readonly last_seen_at: string;
    };
    const insertProgram: Effect.Effect<Inserted, never, DbConnection | Uuid> = Effect.gen(function* () {
      const conn = yield* DbConnection;
      const uuid = yield* Uuid;
      const id = yield* uuid.make();
      const now = new Date().toISOString();
      conn.handle.run(
        `INSERT INTO actors (id, type, name, trust_score, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, type, name, trustScore, now, now],
      );
      return { id, trust_score: trustScore, first_seen_at: now, last_seen_at: now };
    });
    const insertExit = await runtime.runPromiseExit(
      insertProgram as unknown as Effect.Effect<Inserted, unknown, never>,
    );
    if (insertExit._tag === "Failure") {
      const cause = (insertExit as { cause: unknown }).cause;
      const err = JSON.stringify(cause);
      if (err.includes("SQLITE_CONSTRAINT_UNIQUE") || err.includes("UNIQUE constraint failed")) {
        return c.json(
          { error: "conflict", message: `actor with name '${name}' already exists`, name },
          409,
        );
      }
      return c.json({ error: "internal", cause }, 500);
    }
    const inserted = (insertExit as { value: Inserted }).value;

    // 4. Emit actor_registered event (optional, gated on session_id)
    let event: EventRow | null = null;
    if (sessionId !== undefined) {
      const eventProgram: Effect.Effect<EventRow, unknown, SessionService> = Effect.gen(function* () {
        const svc = yield* SessionService;
        const r = yield* svc.appendEvent({
          sessionId,
          type: "actor_registered",
          payload: {
            actor_type: type,
            actor_name: name,
            trust_score: trustScore,
          },
          actor: { name: "system", type: "system" },
        });
        return r.event;
      });
      const eventExit = await runtime.runPromiseExit(
        eventProgram as unknown as Effect.Effect<EventRow, unknown, never>,
      );
      if (eventExit._tag === "Success") {
        event = (eventExit as { value: EventRow }).value;
      }
      // If event emission fails we still keep the actor row — the
      // registration is the source of truth.
    }

    return c.json(
      envelope("actor.registered", {
        actor: {
          id: inserted.id,
          type,
          name,
          trust_score: inserted.trust_score,
          first_seen_at: inserted.first_seen_at,
          last_seen_at: inserted.last_seen_at,
        },
        event_id: event?.id ?? null,
      }),
      201,
    );
  });
};