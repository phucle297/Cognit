/**
 * apps/server/src/index.ts — Hono agent read API (phase 3d + 5.x).
 *
 * Boots on `127.0.0.1:6971` by default (API port). The dashboard
 * (phase 6) is served by the same process on the same port.
 *
 * The server shares the project's `.cognit/cognit.db` SQLite file
 * with the CLI; both processes use the same append-only event log.
 * Concurrent reads are safe; the DB is opened with WAL.
 *
 * Local-only tool: NO auth. The server is bound to loopback by
 * default (`127.0.0.1`); for docker compose we bind `0.0.0.0` but
 * the server stays inside the user-defined docker network — there
 * is no published port. Treat the loopback boundary as the only
 * security guarantee.
 *
 * Routes:
 *   GET  /healthz, /health         (orchestrator probe)
 *   GET  /sessions
 *   GET  /sessions/:id
 *   GET  /sessions/:id/state
 *   GET  /sessions/:id/events
 *   GET  /events/feed
 *   GET  /events/stream            SSE
 *   POST /events                   (funneled through appendEvent)
 *   GET  /*                        serveStatic dashboard dist (phase 6)
 */
import { Command } from "commander";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Effect, Layer, ManagedRuntime } from "effect";
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
  ActorDefaults,
  ActorDefaultsBuiltIn,
  actorDefaultsLayer,
  runInboxWatcher,
  type InboxWatcherConfig,
} from "@cognit/db";
import { EventBus, EventBusLive } from "./bus.js";
import { registerHealthz } from "./routes/healthz.js";
import { registerSessionsRoutes } from "./routes/sessions.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerEdgesRoutes } from "./routes/edges.js";
import { registerVerifyRoutes } from "./routes/verify.js";
import { registerActorsRoutes } from "./routes/actors.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerRulesRoutes } from "./routes/rules.js";
import { resolveServerConfig } from "./config.js";
import { requestIdMiddleware } from "./api-error.js";
import { findProjectRoot } from "@cognit/core/paths";

const program = new Command();
program
  .name("cognit-server")
  .description("cognit read API server (phase 3d + 5.x)")
  .option("--host <ip>", "bind host", "127.0.0.1")
  .option("--port <n>", "bind port", (v: string) => Number(v), 6971)
  .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
  .option(
    "--watch-inbox",
    "run an in-process inbox watcher (covers the dashboard/SSE realtime case; §4.3)",
  )
  .parse(process.argv);

const opts = program.opts<{ host: string; port: number; root?: string; watchInbox?: boolean }>();
const root = opts.root ?? findProjectRoot();
if (!root) {
  process.stderr.write(
    "cognit-server: not in a cognit project and --root not set\n",
  );
  process.exit(2);
}

const dbPath = `${root}/.cognit/cognit.db`;

// Build the runtime layer. The server shares the same DbLive
// composition the CLI uses. We add EventBusLive on top.
//
// Redaction (D-M1-04): server uses built-in patterns only. Loading
// `cognit.yaml` redaction.patterns would require a YAML dependency
// the server package does not carry; CLI paths load user patterns via
// `withAppLayerAndConfig`. Documented parity gap — not silent.
//
// CRITICAL: use `ManagedRuntime` (not `Effect.provide(layer)`) so the
// `EventBusLive` `Ref<subscribers>` is created ONCE at startup and
// shared across every Hono request. With `Effect.provide` per-request,
// each request got a fresh `subsRef` and SSE live-delivery was
// silently broken (SSE handler subscribed, but the bus had an empty
// subscriber list — POST /events published to nobody).
const appLayer = Layer.provideMerge(
  Layer.provideMerge(
    DbLive(dbPath, SessionPolicyDefault),
    Layer.mergeAll(EventBusLive, LoggerNoop, UuidLive),
  ),
  actorDefaultsLayer(ActorDefaultsBuiltIn),
) as Layer.Layer<
  DbConnection | EventStore | SessionService | ConstraintPolicy | ProjectService | EventBus | Logger | Uuid | ActorDefaults,
  never,
  never
>;

const runtime = ManagedRuntime.make(appLayer);

// Resolve projectId. v1 is single-project-per-db. Empty volumes
// (fresh `docker compose up -d` after `down -v`) have a migrated
// schema but no project row — auto-ensure one so the API boots
// without a demo seed or manual `cognit init` inside the container.
// Name: $COGNIT_PROJECT_NAME, else "local". Idempotent via ProjectService.ensure.
const DEFAULT_PROJECT_NAME = process.env["COGNIT_PROJECT_NAME"]?.trim() || "local";
const projectIdEffect = Effect.gen(function* () {
  const service = yield* ProjectService;
  const projects = yield* service.list();
  if (projects.length > 0) {
    return projects[0]!.id;
  }
  const row = yield* service.ensure({ name: DEFAULT_PROJECT_NAME });
  yield* Effect.sync(() =>
    process.stderr.write(
      `cognit-server: created default project name=${DEFAULT_PROJECT_NAME} id=${row.id}\n`,
    ),
  );
  return row.id;
});
const projectId = await runtime.runPromise(projectIdEffect);

// Resolve bind host (loopback default). Auth is gone — this is a
// local tool, no token, no cookie. The cfg log line below reflects
// that.
const cfg = resolveServerConfig({ cliHost: opts.host });
process.stderr.write(
  `cognit-server: local mode — no auth (open ${cfg.bind}:${opts.port})\n`,
);

// Build the Hono app
const app = new Hono();
// Stamp every request with a ULID request_id BEFORE CORS so error
// envelopes (including 403 from the loopback-only CORS gate) carry
// a request_id for support tickets.
app.use("*", requestIdMiddleware);
// Loopback-only CORS: this is a local-only tool. Reject any
// Origin that is not http://localhost:<port> or http://127.0.0.1:<port>.
// Wildcard ACAO would let any web page call the unauthenticated API
// (no token, no cookie — local-only). Even though the server is
// bound to loopback, the browser fetch path requires the loopback
// Origin to be echoed back explicitly for the response to be
// readable to the dashboard.
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && LOOPBACK_ORIGIN_RE.test(origin)) {
    c.header("access-control-allow-origin", origin);
    c.header("vary", "Origin");
  }
  c.header("access-control-allow-headers", "content-type, x-request-id");
  c.header("access-control-allow-methods", "GET,POST,OPTIONS");
  c.header("access-control-expose-headers", "x-request-id");
  await next();
});
app.options("*", (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && !LOOPBACK_ORIGIN_RE.test(origin)) {
    return c.body(null, 403);
  }
  return c.body(null, 204);
});

registerHealthz(app);
// Search registers BEFORE sessions routes: `/api/sessions/:id`
// would otherwise swallow `/api/sessions/search` as a session with
// id "search". Static segments win when registered first.
registerSearchRoutes(app, { runtime, projectId });
registerSessionsRoutes(app, { runtime, projectId });
registerEventsRoutes(app, { runtime, projectId });
registerProjectsRoutes(app, { runtime });
registerEdgesRoutes(app, { runtime, projectId });
registerVerifyRoutes(app, { runtime, projectId });
registerActorsRoutes(app, { runtime, projectId });
registerRulesRoutes(app, { runtime, projectId });

// Same-origin dashboard (phase 6): serve `apps/dashboard/dist` from
// the same port. `serveStatic` resolves lazily per-request; if the
// dist does not exist yet, every GET /* falls through to 404.
// Static files are served before auth (the dashboard is the entry
// point), and the auth gate above exempts only API routes.
const dashboardRoot = path.resolve(root, "..", "apps", "dashboard", "dist");
app.use(
  "*",
  serveStatic({
    root: dashboardRoot,
  }) as unknown as Parameters<typeof app.use>[1],
);

let server: ReturnType<typeof serve> | undefined;
server = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }, (info) => {
  process.stdout.write(
    `cognit-server: listening on http://${info.address}:${info.port}\n`,
  );
  process.stdout.write(
    `cognit-server: project=${projectId} db=${dbPath} bind=${cfg.bind}\n`,
  );
});

// §4.3: optional in-process inbox watcher. Covers the dashboard/SSE
// realtime case without a separate `cognit inbox --watch` process. The
// server does not parse cognit.yaml (no YAML dep), so this is an
// explicit opt-in flag rather than the `inbox.watch:true` knob — a
// documented parity gap (like the redaction one).
let watcherStop: (() => Promise<void>) | undefined;
if (opts.watchInbox) {
  const watchConfig: InboxWatcherConfig = {
    inboxDir: path.join(root, ".cognit", "inbox"),
    processedDir: path.join(root, ".cognit", "processed"),
    errorDir: path.join(root, ".cognit", "inbox", "_error"),
    debounceMs: 200,
    projectId,
    projectRoot: root,
  };
  watcherStop = (await runtime.runPromise(runInboxWatcher(watchConfig))).stop;
  process.stdout.write("cognit-server: in-process inbox watcher started\n");
}

// SIGTERM / SIGINT: shut the bus down so every in-flight SSE drain
// fiber rejects its `Queue.take` and exits cleanly. The HTTP server
// then closes on `server.close()`. Without this, a graceful restart
// leaves connected SSE clients hanging until their TCP keepalive
// times out (minutes).
const shutdownBus = Effect.gen(function* () {
  const bus = yield* EventBus;
  yield* bus.shutdown;
}).pipe(Effect.ignoreLogged);

const handleShutdown = (signal: string) => {
  process.stderr.write(`cognit-server: received ${signal}, shutting down\n`);
  void runtime.runPromise(shutdownBus).then(async () => {
    await watcherStop?.().catch(() => undefined);
    server?.close(() => process.exit(0));
    // Hard exit if server.close hangs (e.g. blocked keepalive).
    setTimeout(() => process.exit(1), 5_000).unref();
  });
};
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));