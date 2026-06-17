/**
 * apps/server/test/helpers.ts — shared test fixtures.
 *
 * Three helpers, used by the five split test files:
 *
 *   - `makeApp()` — bare Hono app, no auth. Mirrors the production
 *     boot path (CORS, healthz, sessions, events routes) but with
 *     no auth gate. Used by healthz, sessions, events, and
 *     redaction tests.
 *
 *   - `makeAppWithAuth({apiToken, isLoopback})` — same as `makeApp`
 *     plus the same auth gate middleware as `src/index.ts`:
 *     loopback bypass → /health, /healthz, /auth/login exempt →
 *     requireBearer elsewhere (with cookie fallback). Mirrors the
 *     exact production wiring so divergence is impossible.
 *
 *   - `bootServer({port: 0, apiToken?, isLoopback?})` — starts a
 *     real HTTP server on an OS-assigned port. Returns the URL
 *     (e.g. `http://127.0.0.1:51234`) plus a `close` callback. Used
 *     by the SSE test, which needs a real socket to read the
 *     `ReadableStream` body.
 *
 * Each helper also bootstraps one project + one session in the
 * temp DB so tests can use a known `sessionId` without re-running
 * migrations.
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
  Logger,
  LoggerNoop,
  ProjectService,
  SessionPolicyDefault,
  SessionService,
  ConstraintPolicy,
  Uuid,
  UuidLive,
} from "@cognit/db";
import { EventBus, EventBusLive } from "../src/bus.js";
import { requireBearer } from "../src/auth.js";
import {
  resolveAuthConfig,
  buildServerConfig,
  type AuthConfig,
  type BindAddress,
} from "../src/config.js";
import { registerHealthz } from "../src/routes/healthz.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { registerSessionsRoutes, type ServerRuntime } from "../src/routes/sessions.js";
import { registerEventsRoutes } from "../src/routes/events.js";
import { registerProjectsRoutes } from "../src/routes/projects.js";
import { registerEdgesRoutes } from "../src/routes/edges.js";
import { registerVerifyRoutes } from "../src/routes/verify.js";
import { registerActorsRoutes } from "../src/routes/actors.js";
import { requestIdMiddleware } from "../src/api-error.js";

/** All Context tags the test runtime provides. Mirrors `src/index.ts`. */
type TestContext =
  | DbConnection
  | EventStore
  | SessionService
  | ProjectService
  | ConstraintPolicy
  | EventBus
  | Logger
  | Uuid;

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
    Layer.mergeAll(EventBusLive, LoggerNoop, UuidLive),
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
 * Build a Hono app with the same CORS + routes + auth gate as
 * production. `auth` null = no auth (loopback / open); non-null =
 * full gate.
 */
const buildHono = (
  runtime: ServerRuntime,
  projectId: string,
  auth: AuthConfig | null,
): Hono => {
  const app = new Hono();
  app.use("*", requestIdMiddleware);
  app.use("*", async (c, next) => {
    c.header("access-control-allow-origin", "*");
    c.header("access-control-allow-headers", "content-type, authorization, x-request-id");
    c.header("access-control-allow-methods", "GET,POST,OPTIONS");
    c.header("access-control-expose-headers", "x-request-id");
    await next();
  });
  app.options("*", (c) => c.body(null, 204));

  // Mirror the production auth gate (plan §5.3.4).
  const cfg = auth === null ? null : buildServerConfig(auth);
  if (auth !== null && cfg !== null && cfg.enforceAuth) {
    app.use("*", async (c, next) => {
      if (
        c.req.path === "/health" ||
        c.req.path === "/healthz" ||
        c.req.path === "/auth/login"
      ) {
        return next();
      }
      return requireBearer(auth)(c, next);
    });
  }

  registerHealthz(app);
  if (auth !== null) registerAuthRoutes(app, auth);
  registerSessionsRoutes(app, { runtime, projectId });
  registerEventsRoutes(app, { runtime, projectId });
  registerProjectsRoutes(app, { runtime });
  registerEdgesRoutes(app, { runtime, projectId });
  registerVerifyRoutes(app, { runtime, projectId });
  registerActorsRoutes(app, { runtime, projectId });
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
 * Bare Hono app, no auth. Returns the app + a server-side handle
 * (`runtime`, `projectId`, `sessionId`, `dbPath`) plus a `close`
 * that removes the temp DB.
 */
export const makeApp = async (): Promise<TestApp> => {
  const tmp = await mkTemp();
  const { runtime, managed, closeRuntime } = await buildRuntime(tmp.dbPath);
  const { projectId, sessionId } = await bootstrap(managed);
  const app = buildHono(runtime, projectId, null);
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

/**
 * Hono app with the production auth gate when the bind is
 * non-loopback AND `apiToken` is non-empty. Mirrors `src/index.ts`.
 */
export const makeAppWithAuth = async (opts: {
  apiToken: string;
  isLoopback: boolean;
}): Promise<TestApp> => {
  const tmp = await mkTemp();
  const { runtime, managed, closeRuntime } = await buildRuntime(tmp.dbPath);
  const { projectId, sessionId } = await bootstrap(managed);
  const bind: BindAddress = opts.isLoopback ? "127.0.0.1" : "0.0.0.0";
  const auth = resolveAuthConfig({
    yamlToken: opts.apiToken,
    yamlBind: bind,
  });
  const app = buildHono(runtime, projectId, auth);
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
export const bootServer = async (opts: {
  port?: number;
  apiToken?: string;
  isLoopback?: boolean;
} = {}): Promise<BootedServer> => {
  const port = opts.port ?? 0;
  const isLoopback = opts.isLoopback ?? true;
  const apiToken = opts.apiToken;
  const tmp = await mkTemp();
  const { runtime, managed, closeRuntime } = await buildRuntime(tmp.dbPath);
  const { projectId, sessionId } = await bootstrap(managed);
  const auth =
    apiToken !== undefined
      ? resolveAuthConfig({
          yamlToken: apiToken,
          yamlBind: isLoopback ? "127.0.0.1" : "0.0.0.0",
        })
      : null;
  const app = buildHono(runtime, projectId, auth);

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