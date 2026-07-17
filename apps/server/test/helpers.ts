/**
 * apps/server/test/helpers.ts — shared test fixtures.
 *
 * Three helpers, used by the split test files:
 *
 *   - `makeApp()` — bare Hono app. Mirrors the production boot path
 *     (CORS, healthz, sessions, events routes). Local-only — no
 *     auth gate, no cookie, no token.
 *
 *   - `bootServer({port: 0})` — starts a real HTTP server on an
 *     OS-assigned port. Returns the URL (e.g. `http://127.0.0.1:51234`)
 *     plus a `close` callback. Used by the SSE test, which needs a
 *     real socket to read the `ReadableStream` body.
 *
 * Each helper also bootstraps one project + one session in the temp
 * DB so tests can use a known `sessionId` without re-running migrations.
 */
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { Effect, Layer, ManagedRuntime } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  DbConnection,
  DbLive,
  EventStore,
  GravityQueries,
  Logger,
  LoggerNoop,
  ProjectService,
  RawEventStore,
  SessionPolicyDefault,
  SessionService,
  SnapshotService,
  ConstraintPolicy,
  VerificationQueries,
  Uuid,
  UuidLive,
  ActorDefaults,
  ActorDefaultsBuiltIn,
  actorDefaultsLayer,
} from "@cognit/db";
import { EventBus, EventBusLive } from "../src/bus.js";
import { registerHealthz } from "../src/routes/healthz.js";
import { registerSessionsRoutes, type ServerRuntime } from "../src/routes/sessions.js";
import { registerEventsRoutes } from "../src/routes/events.js";
import { registerProjectsRoutes } from "../src/routes/projects.js";
import { registerEdgesRoutes } from "../src/routes/edges.js";
import { registerVerifyRoutes } from "../src/routes/verify.js";
import { registerActorsRoutes } from "../src/routes/actors.js";
import { registerSearchRoutes } from "../src/routes/search.js";
import { registerRulesRoutes } from "../src/routes/rules.js";
import { requestIdMiddleware } from "../src/api-error.js";

/** All Context tags the test runtime provides. Mirrors `src/index.ts`. */
type TestContext =
  | DbConnection
  | EventStore
  | SessionService
  | SnapshotService
  | ProjectService
  | ConstraintPolicy
  | VerificationQueries
  | GravityQueries
  | RawEventStore
  | EventBus
  | Logger
  | Uuid
  | ActorDefaults;

export interface TestApp {
  readonly app: Hono;
  readonly runtime: ServerRuntime;
  readonly projectId: string;
  readonly sessionId: string;
  readonly dbPath: string;
  readonly close: () => Promise<void>;
}

/**
 * Bootstrap one project + one session in the temp DB. Uses the
 * `ManagedRuntime` directly so the layer is built once and the
 * `EventBus` instance is shared with subsequent calls.
 */
const bootstrap = async (
  managed: ManagedRuntime.ManagedRuntime<TestContext, never>,
): Promise<{ projectId: string; sessionId: string }> => {
  const projectId = await managed.runPromise(
    Effect.gen(function* () {
      const conn = yield* DbConnection;
      const id = "01projectxxxxxxxxxxxxxxxxx";
      conn.handle.run(
        `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
        [id, "test", new Date().toISOString()],
      );
      return id;
    }),
  );
  const sessionId = await managed.runPromise(
    Effect.gen(function* () {
      const svc = yield* SessionService;
      const r = yield* svc.create({ projectId, goal: "server test", actor: { name: "alice", type: "human" } });
      return r.session.id;
    }),
  );
  return { projectId, sessionId };
};

/**
 * Build a runtime ONCE and share it across all `runPromise` /
 * `runPromiseExit` calls. This is the critical part: `Effect.provide`
 * without a shared memo map rebuilds the layer on every call, which
 * means each Hono handler would get a fresh `EventBus` instance
 * with an empty `subsRef`. The SSE subscriber's queue is registered
 * on bus instance A; the POST handler's `publish` hits bus instance
 * B; nothing crosses over.
 *
 * `ManagedRuntime.make` builds the layer once via a memoMap and
 * returns a `Runtime` whose services are shared across calls.
 *
 * The layer's error channel is widened to `DbError | DbCorrupted`
 * by `DbLive` — `ManagedRuntime.make` accepts that, and we surface
 * it as a thrown error if the layer ever fails to build (in
 * practice it won't; the temp DB file is fresh).
 */
const buildRuntime = async (
  dbPath: string,
): Promise<{
  runtime: ServerRuntime;
  managed: ManagedRuntime.ManagedRuntime<TestContext, never>;
  closeRuntime: () => Promise<void>;
}> => {
  const appLayer = Layer.provideMerge(
    DbLive(dbPath, SessionPolicyDefault),
    Layer.mergeAll(
      EventBusLive,
      LoggerNoop,
      UuidLive,
      actorDefaultsLayer(ActorDefaultsBuiltIn),
    ),
  );
  // `ManagedRuntime.make` is synchronous in effect@3.21 — it returns
  // the ManagedRuntime object directly, which has `runPromise` and
  // `dispose` methods. We don't need to wrap it in `Effect.scoped`.
  const managed = ManagedRuntime.make(
    appLayer as Layer.Layer<TestContext, never, never>,
  );
  return {
    runtime: {
      runPromise: <A, E>(eff: Effect.Effect<A, E, never>) =>
        managed.runPromise(
          eff as unknown as Effect.Effect<A, E, TestContext>,
        ),
      runPromiseExit: <A, E>(eff: Effect.Effect<A, E, never>) =>
        managed.runPromiseExit(
          eff as unknown as Effect.Effect<A, E, TestContext>,
        ),
      runFork: <A, E>(eff: Effect.Effect<A, E, never>) =>
        managed.runFork(
          eff as unknown as Effect.Effect<A, E, TestContext>,
        ),
    },
    managed,
    closeRuntime: () => managed.dispose(),
  };
};

/**
 * Build a Hono app mirroring the production boot path: CORS,
 * healthz, sessions, events, projects, edges, verify, actors. No
 * auth gate (local-only tool).
 */
const buildHono = (
  runtime: ServerRuntime,
  projectId: string,
): Hono => {
  const app = new Hono();
  app.use("*", requestIdMiddleware);
  app.use("*", async (c, next) => {
    c.header("access-control-allow-origin", "*");
    c.header("access-control-allow-headers", "content-type, x-request-id");
    c.header("access-control-allow-methods", "GET,POST,OPTIONS");
    c.header("access-control-expose-headers", "x-request-id");
    await next();
  });
  app.options("*", (c) => c.body(null, 204));

  registerHealthz(app);
  // Search must register BEFORE the sessions routes: `/api/sessions/:id`
  // would otherwise swallow `/api/sessions/search` as a session with
  // id "search" and 404. Static segments win when registered first.
  registerSearchRoutes(app, { runtime, projectId });
  registerSessionsRoutes(app, { runtime, projectId });
  registerEventsRoutes(app, { runtime, projectId });
  registerProjectsRoutes(app, { runtime });
  registerEdgesRoutes(app, { runtime, projectId });
  registerVerifyRoutes(app, { runtime, projectId });
  registerActorsRoutes(app, { runtime, projectId });
  registerRulesRoutes(app, { runtime, projectId });
  return app;
};

const mkTemp = async (): Promise<{ dir: string; dbPath: string; close: () => Promise<void> }> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-srv-"));
  const dbPath = path.join(dir, "cognit.db");
  await fs.mkdir(path.join(dir, ".cognit"), { recursive: true });
  return {
    dir,
    dbPath,
    close: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
};

/**
 * Bare Hono app. Returns the app + a server-side handle (`runtime`,
 * `projectId`, `sessionId`, `dbPath`) plus a `close` that removes
 * the temp DB.
 */
export const makeApp = async (): Promise<TestApp> => {
  const tmp = await mkTemp();
  const { runtime, managed, closeRuntime } = await buildRuntime(tmp.dbPath);
  const { projectId, sessionId } = await bootstrap(managed);
  const app = buildHono(runtime, projectId);
  return {
    app,
    runtime,
    projectId,
    sessionId,
    dbPath: tmp.dbPath,
    close: async () => {
      await closeRuntime();
      await tmp.close();
    },
  };
};

export interface BootedServer {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly app: Hono;
  readonly projectId: string;
  readonly sessionId: string;
  readonly dbPath: string;
}

/**
 * Start a real HTTP server on an OS-assigned port (`port: 0`).
 * Resolves once the listener is up. `url` is `http://127.0.0.1:<port>`.
 *
 * Used by the SSE test, which needs a real socket to read the
 * `ReadableStream` body (`Hono.app.fetch` doesn't expose
 * `Response.body.getReader()` over a real network round-trip in
 * vitest unless there's a listening socket).
 */
export const bootServer = async (
  opts: { port?: number } = {},
): Promise<BootedServer> => {
  const port = opts.port ?? 0;
  const tmp = await mkTemp();
  const { runtime, managed, closeRuntime } = await buildRuntime(tmp.dbPath);
  const { projectId, sessionId } = await bootstrap(managed);
  const app = buildHono(runtime, projectId);

  return new Promise<BootedServer>((resolve, reject) => {
    let server: ServerType | null = null;
    let resolved = false;
    server = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port },
      (info) => {
        if (resolved) return;
        resolved = true;
        const url = `http://127.0.0.1:${info.port}`;
        resolve({
          url,
          projectId,
          sessionId,
          app,
          dbPath: tmp.dbPath,
          close: async () => {
            server?.close();
            await closeRuntime();
            await tmp.close();
          },
        });
      },
    );
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { server?.close(); } catch { /* ignore */ }
      reject(new Error("bootServer: timed out waiting for listen callback"));
    }, 5000).unref();
  });
};

/**
 * `app.fetch` invoker with a `localhost` base URL. Mirrors the
 * existing pattern in the old `server.test.ts` so the new files
 * stay short.
 */
export const fetchApp = (app: Hono) => async (
  path: string,
  init: RequestInit = {},
): Promise<Response> => app.fetch(new Request(`http://localhost${path}`, init));

/**
 * Parse an SSE chunk into frames. SSE frames are
 * `event: <name>\ndata: <json>\n\n`. We split on the double-newline
 * and parse each block.
 *
 * Exported so the phase-5 E2E and `sse-bus.test.ts` share one parser.
 */
export const parseSseFrames = (
  chunk: string,
): Array<{ event: string; data: string }> => {
  const frames: Array<{ event: string; data: string }> = [];
  for (const block of chunk.split("\n\n")) {
    if (!block) continue;
    let eventName = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) eventName = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data += line.slice("data: ".length);
    }
    if (data) frames.push({ event: eventName, data });
  }
  return frames;
};

/**
 * Read from a `ReadableStreamDefaultReader` until `predicate(acc)`
 * returns true, or until `timeoutMs` elapses. Returns the
 * accumulated text. Throws on timeout with the accumulated text in
 * the error message.
 *
 * Exported so the phase-5 E2E and `sse-bus.test.ts` share one helper.
 */
export const readUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>,
  decoder: InstanceType<typeof TextDecoder>,
  predicate: (acc: string) => boolean,
  timeoutMs: number,
): Promise<string> => {
  const acc: string[] = [];
  const start = Date.now();
  let done = false;
  while (!done) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`readUntil: timed out after ${timeoutMs}ms. Accumulated: ${acc.join("")}`);
    }
    const remain = Math.max(1, timeoutMs - (Date.now() - start));
    const { value, done: rdone } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), remain),
      ),
    ]);
    if (value) {
      const text = decoder.decode(value, { stream: true });
      acc.push(text);
      if (predicate(acc.join(""))) {
        done = true;
      }
    }
    if (rdone) {
      done = true;
    }
  }
  return acc.join("");
};