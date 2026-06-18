/**
 * apps/server/src/index.ts — Hono agent read API (phase 3d + 5.x).
 *
 * Boots on `127.0.0.1:6971` by default (API port). The dashboard
 * (phase 6) is served by the same process on the same port so the
 * browser EventSource can use same-origin cookies for auth.
 *
 * The server shares the project's `.cognit/cognit.db` SQLite file
 * with the CLI; both processes use the same append-only event log.
 * Concurrent reads are safe; the DB is opened with WAL.
 *
 * Routes:
 *   GET  /healthz, /health         no auth (orchestrator probe)
 *   GET  /auth/login               no auth (HTML form)
 *   POST /auth/login               no auth (sets session cookie)
 *   GET  /sessions                 bearer or cookie
 *   GET  /sessions/:id             bearer or cookie
 *   GET  /sessions/:id/state       bearer or cookie
 *   GET  /sessions/:id/events      bearer or cookie
 *   GET  /events/feed              bearer or cookie
 *   GET  /events/stream            SSE (bearer or cookie)
 *   POST /events                   bearer or cookie (funneled through appendEvent)
 *   GET  /*                        serveStatic dashboard dist (phase 6)
 *
 * Auth: opt-in bearer or same-origin cookie. See `auth.ts`. Token
 * precedence: env `COGNIT_API_TOKEN` > CLI `--api-token` > yaml
 * `auth.api_token`. Default (loopback bind, no token) is fully open.
 */
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs/promises";
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
} from "@cognit/db";
import { EventBus, EventBusLive } from "./bus.js";
import { requireBearer } from "./auth.js";
import { registerHealthz } from "./routes/healthz.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSessionsRoutes } from "./routes/sessions.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerEdgesRoutes } from "./routes/edges.js";
import { registerVerifyRoutes } from "./routes/verify.js";
import { registerActorsRoutes } from "./routes/actors.js";
import {
  buildServerConfig,
  resolveAuthConfig,
  type BindAddress,
} from "./config.js";
import { findProjectRoot } from "../../../packages/cli/src/paths.js";

const program = new Command();
program
  .name("cognit-server")
  .description("cognit read API server (phase 3d + 5.x)")
  .option("--host <ip>", "bind host", "127.0.0.1")
  .option("--port <n>", "bind port", (v: string) => Number(v), 6971)
  .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
  .option("--api-token <token>", "bearer token (overrides env; env overrides yaml)")
  .parse(process.argv);

const opts = program.opts<{ host: string; port: number; root?: string; apiToken?: string }>();
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
// CRITICAL: use `ManagedRuntime` (not `Effect.provide(layer)`) so the
// `EventBusLive` `Ref<subscribers>` is created ONCE at startup and
// shared across every Hono request. With `Effect.provide` per-request,
// each request got a fresh `subsRef` and SSE live-delivery was
// silently broken (SSE handler subscribed, but the bus had an empty
// subscriber list — POST /events published to nobody).
const appLayer = Layer.provideMerge(
  DbLive(dbPath, SessionPolicyDefault),
  Layer.merge(EventBusLive, LoggerNoop),
) as Layer.Layer<
  DbConnection | EventStore | SessionService | ConstraintPolicy | ProjectService | EventBus | Logger,
  never,
  never
>;

const runtime = ManagedRuntime.make(appLayer);

// Read projectId from the DB. There is exactly one project per
// `.cognit/cognit.db` (v1 single-project). The DB must exist
// (run `cognit init` first).
const projectIdEffect = Effect.gen(function* () {
  const service = yield* ProjectService;
  const projects = yield* service.list();
  if (projects.length === 0) {
    return yield* Effect.fail(
      new Error(
        `cognit-server: no project found in ${dbPath}. Run \`cognit init\` first.`,
      ),
    );
  }
  return projects[0]!.id;
});
const projectId = await runtime.runPromise(projectIdEffect);

// Resolve auth config. Token precedence: env > CLI > yaml.
// We intentionally avoid the `readConfig` schema because the
// `auth:` block is server-only and written by hand; the round-trip
// through `CognitConfigSchema` (which models CLI-known fields) would
// silently drop it. The auth block is read by three small regexes.
const rawConfig = await fs.readFile(path.join(root, ".cognit", "cognit.yaml"), "utf8");
// `auth:` block. Match either an `auth:` top-level key (phase 5.3)
// or the legacy `server:` block (phase 3d) for back-compat.
const authBlockMatch = rawConfig.match(
  /^[ \t]*auth:[ \t]*\n((?:[ \t]+[^\n]+\n?)*)/m,
);
const serverBlockMatch = rawConfig.match(
  /^[ \t]*server:[ \t]*\n((?:[ \t]+[^\n]+\n?)*)/m,
);
const authBlockText = authBlockMatch?.[1] ?? serverBlockMatch?.[1] ?? "";
const yamlTokenMatch = authBlockText.match(
  /^[ \t]*api_token:[ \t]*['"]?([^'"\n]+)['"]?/m,
);
const yamlBindMatch = authBlockText.match(
  /^[ \t]*bind:[ \t]*['"]?([^'"\n]+)['"]?/m,
);
const yamlCookieNameMatch = authBlockText.match(
  /^[ \t]*cookie_name:[ \t]*['"]?([^'"\n]+)['"]?/m,
);
const yamlCookieSecureMatch = authBlockText.match(
  /^[ \t]*cookie_secure:[ \t]*(true|false|1|0)['"]?[ \t]*$/m,
);
const yamlBind = (yamlBindMatch?.[1] as BindAddress | undefined) ?? undefined;
const yamlCookieSecure = yamlCookieSecureMatch
  ? yamlCookieSecureMatch[1] === "true" || yamlCookieSecureMatch[1] === "1"
  : undefined;
const envCookieSecure = process.env.COGNIT_COOKIE_SECURE
  ? process.env.COGNIT_COOKIE_SECURE === "true" || process.env.COGNIT_COOKIE_SECURE === "1"
  : undefined;

const auth = resolveAuthConfig({
  envToken: process.env.COGNIT_API_TOKEN,
  cliToken: opts.apiToken,
  yamlToken: yamlTokenMatch?.[1],
  cliHost: opts.host,
  yamlBind,
  yamlCookieName: yamlCookieNameMatch?.[1],
  yamlCookieSecure,
  envCookieSecure,
});
const cfg = buildServerConfig(auth);
if (cfg.enforceAuth) {
  process.stderr.write(
    `cognit-server: bearer auth enabled (bind=${auth.bind}, cookie=${auth.cookieName})\n`,
  );
} else if (auth.apiToken && cfg.isLoopback) {
  process.stderr.write(
    `cognit-server: WARNING — api_token set but bind=${auth.bind} is loopback; auth is OFF\n`,
  );
} else if (!auth.apiToken) {
  process.stderr.write(
    `cognit-server: no api_token configured; auth is OFF (open ${auth.bind}:${opts.port})\n`,
  );
}

// Build the Hono app
const app = new Hono();
app.use("*", async (c, next) => {
  // CORS for local browser dev
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-headers", "content-type, authorization");
  c.header("access-control-allow-methods", "GET,POST,OPTIONS");
  await next();
});
app.options("*", (c) => c.body(null, 204));

// Auth gate. Mount order (plan §5.3.4):
//   1. Loopback bypass (cfg.enforceAuth === false).
//   2. /health and /healthz — orchestrator probe must work.
//   3. /auth/login (GET form + POST cookie) — entry point.
//   4. requireBearer on everything else.
app.use("*", async (c, next) => {
  if (!cfg.enforceAuth) return next();
  if (
    c.req.path === "/health" ||
    c.req.path === "/healthz" ||
    c.req.path === "/auth/login"
  ) {
    return next();
  }
  return requireBearer(auth)(c, next);
});

registerHealthz(app);
registerAuthRoutes(app, auth);
registerSessionsRoutes(app, { runtime, projectId });
registerEventsRoutes(app, { runtime, projectId });
registerProjectsRoutes(app, { runtime });
registerEdgesRoutes(app, { runtime, projectId });
registerVerifyRoutes(app, { runtime, projectId });
registerActorsRoutes(app, { runtime, projectId });

// Same-origin dashboard (phase 6): serve `apps/dashboard/dist` from
// the same port. `serveStatic` resolves lazily per-request; if the
// dist does not exist yet, every GET /* falls through to 404.
// Static files are served before auth (the dashboard is the entry
// point), and the auth gate above exempts only API routes.
const dashboardRoot = path.resolve(root, "..", "apps", "dashboard", "dist");
app.get(
  "*",
  serveStatic({
    root: dashboardRoot,
  }),
);

let server: ReturnType<typeof serve> | undefined;
server = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }, (info) => {
  process.stdout.write(
    `cognit-server: listening on http://${info.address}:${info.port}\n`,
  );
  process.stdout.write(
    `cognit-server: project=${projectId} db=${dbPath} auth=${cfg.enforceAuth ? "bearer+cookie" : "off"} bind=${auth.bind}\n`,
  );
});

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
  void runtime.runPromise(shutdownBus).then(() => {
    server?.close(() => process.exit(0));
    // Hard exit if server.close hangs (e.g. blocked keepalive).
    setTimeout(() => process.exit(1), 5_000).unref();
  });
};
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));