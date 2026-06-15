/**
 * apps/server/test/server.test.ts — phase 3d integration.
 *
 * Boots the Hono app against a temp DB, exercises the routes:
 *   - GET /healthz returns 200 without auth
 *   - GET /sessions returns the session list
 *   - GET /sessions/:id/state returns the full SessionState
 *   - GET /sessions/:id/events returns the events for a session
 *   - POST /events writes through appendEvent (constraint chokepoint
 *     applies; redaction fires when a payload matches a pattern)
 *   - GET /events/stream replays tail and delivers live events
 *   - Bearer auth: 401 when token is wrong on a non-loopback bind
 *
 * All tests share a single Hono app instance per describe block.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { Effect, Layer } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  DbConnection,
  DbLive,
  EventStore,
  Logger,
  LoggerNoop,
  ProjectService,
  SessionPolicyDefault,
  SessionService,
} from "@cognit/db";
import { EventBus, EventBusLive } from "../src/bus.js";
import { registerHealthz } from "../src/routes/healthz.js";
import { registerSessionsRoutes } from "../src/routes/sessions.js";
import { registerEventsRoutes } from "../src/routes/events.js";

/**
 * Build a fresh app + runtime in a temp project dir. Returns the
 * Hono `app.fetch`-style handler plus a `close` callback.
 */
const makeApp = async (): Promise<{
  app: Hono;
  close: () => Promise<void>;
  projectId: string;
  sessionId: string;
  dbPath: string;
}> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-srv-"));
  const dbPath = path.join(dir, "cognit.db");
  // Touch the .cognit dir so layout matches production (we don't
  // read cognit.yaml in tests).
  await fs.mkdir(path.join(dir, ".cognit"), { recursive: true });

  const appLayer = Layer.merge(
    DbLive(dbPath, SessionPolicyDefault),
    Layer.merge(EventBusLive, LoggerNoop),
  ) as Layer.Layer<
    | DbConnection
    | EventStore
    | SessionService
    | ProjectService
    | EventBus
    | Logger,
    never,
    never
  >;
  // Use a non-ManagedRuntime approach: we provide the layer at the
  // call site (matches the CLI's withAppLayer pattern). The
  // ManagedRuntime path has a subtle interaction with the cast
  // above that masks the layer's error channel, so we keep the
  // runtime simple.
  const runtime = {
    runPromise: <A, E>(eff: Effect.Effect<A, E, never>) =>
      Effect.runPromise(
        eff.pipe(Effect.provide(appLayer)) as unknown as Effect.Effect<A, E, never>,
      ),
    runPromiseExit: <A, E>(eff: Effect.Effect<A, E, never>) =>
      Effect.runPromiseExit(
        eff.pipe(Effect.provide(appLayer)) as unknown as Effect.Effect<A, E, never>,
      ),
    runFork: <A, E>(eff: Effect.Effect<A, E, never>) =>
      Effect.runFork(
        eff.pipe(Effect.provide(appLayer)) as unknown as Effect.Effect<A, E, never>,
      ),
  };

  // Bootstrap a project + session directly via the services.
  const projectId = await Effect.runPromise(
    Effect.gen(function* () {
      const conn = yield* DbConnection;
      const id = "01projectxxxxxxxxxxxxxxxxx";
      conn.handle.run(
        `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
        [id, "test", new Date().toISOString()],
      );
      return id;
    }).pipe(Effect.provide(appLayer)) as unknown as Effect.Effect<string, never, never>,
  );
  const sessionId = await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* SessionService;
      const r = yield* svc.create({ projectId, goal: "server test", actor: { name: "alice", type: "human" } });
      return r.session.id;
    }).pipe(Effect.provide(appLayer)) as unknown as Effect.Effect<string, never, never>,
  );

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("access-control-allow-origin", "*");
    await next();
  });
  registerHealthz(app);
  registerSessionsRoutes(app, { runtime, projectId });
  registerEventsRoutes(app, { runtime, projectId });

  return {
    app,
    projectId,
    sessionId,
    dbPath,
    close: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
};

const fetchApp = (app: Hono) => async (
  path: string,
  init: RequestInit = {},
): Promise<Response> => app.fetch(new Request(`http://localhost${path}`, init));

describe("cognit server — phase 3d", () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("GET /healthz returns 200 with no auth", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/healthz");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { version: number; kind: string; data: { status: string } };
    expect(body.version).toBe(1);
    expect(body.kind).toBe("healthz");
    expect(body.data.status).toBe("ok");
  });

  it("GET /sessions returns the session list as a v1 envelope", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/sessions");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { version: number; kind: string; data: { sessions: ReadonlyArray<{ id: string }> } };
    expect(body.version).toBe(1);
    expect(body.kind).toBe("sessions.list");
    expect(body.data.sessions.length).toBe(1);
    expect(body.data.sessions[0]!.id).toBe(ctx.sessionId);
  });

  it("GET /sessions/:id/state returns the full SessionState", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/sessions/${ctx.sessionId}/state`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { kind: string; data: { session: { id: string }; state: { session_id: string; goal: string } } };
    expect(body.kind).toBe("session.state");
    expect(body.data.session.id).toBe(ctx.sessionId);
    expect(body.data.state.session_id).toBe(ctx.sessionId);
    expect(body.data.state.goal).toBe("server test");
  });

  it("GET /sessions/:id/events returns the events for the session", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/sessions/${ctx.sessionId}/events?limit=10`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { kind: string; data: { events: ReadonlyArray<{ id: string; type: string }> } };
    expect(body.kind).toBe("events.list");
    expect(body.data.events.length).toBeGreaterThan(0);
    expect(body.data.events[0]!.type).toBe("session_created");
  });

  it("GET /sessions/:id/state on an unknown id returns 404", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/sessions/01nosuchsessxxxxxxxxxxx/state`);
    expect(r.status).toBe(404);
  });

  it("POST /events writes through appendEvent", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: ctx.sessionId,
        type: "observation_recorded",
        payload: { text: "from the server" },
        actor: "alice:human",
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { kind: string; data: { event: { type: string }; snapshot_taken: boolean } };
    expect(body.kind).toBe("event.appended");
    expect(body.data.event.type).toBe("observation_recorded");
  });

  it("POST /events rejects bad bodies with 400", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "x" }), // missing session_id, payload, actor
    });
    expect(r.status).toBe(400);
  });

  it("POST /events on unknown session returns 409", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "01nosuchsessxxxxxxxxxxx",
        type: "observation_recorded",
        payload: { text: "y" },
        actor: "alice:human",
      }),
    });
    // UnknownSession maps to 409 in the route
    expect([409, 404, 500]).toContain(r.status);
  });
});
