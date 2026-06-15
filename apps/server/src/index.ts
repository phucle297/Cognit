/**
 * apps/server/src/index.ts — Hono agent read API (phase 3d).
 *
 * Boots on `127.0.0.1:6971` by default (API port; UI/dashboard on
 * `:6970` is a phase 4 follow-up). Configurable via `--host` and
 * `--port` flags.
 *
 * The server shares the project's `.cognit/cognit.db` SQLite file
 * with the CLI; both processes use the same append-only event log.
 * Concurrent reads are safe; the DB is opened with WAL.
 *
 * Routes:
 *   GET  /healthz                  no auth
 *   GET  /sessions                 list sessions
 *   GET  /sessions/:id             session row
 *   GET  /sessions/:id/state       full SessionState
 *   GET  /sessions/:id/events      recent events for a session
 *   GET  /events/feed              recent events project-wide
 *   GET  /events/stream            SSE: replay tail + live
 *   POST /events                   funneled through appendEvent
 *
 * Auth: opt-in bearer only. See `auth.ts`. The default (loopback
 * bind, no token) is fully open; this is the v0.1 local-first
 * posture.
 */
import { Command } from "commander";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
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
import { requireBearer, shouldEnforceAuth } from "./auth.js";
import { registerHealthz } from "./routes/healthz.js";
import { registerSessionsRoutes } from "./routes/sessions.js";
import { registerEventsRoutes } from "./routes/events.js";
import { findProjectRoot } from "../../../packages/cli/src/paths.js";
import { readConfig } from "../../../packages/cli/src/yaml-io.js";

const program = new Command();
program
  .name("cognit-server")
  .description("cognit read API server (phase 3d)")
  .option("--host <ip>", "bind host", "127.0.0.1")
  .option("--port <n>", "bind port", (v: string) => Number(v), 6971)
  .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
  .parse(process.argv);

const opts = program.opts<{ host: string; port: number; root?: string }>();
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
const appLayer = Layer.merge(
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

// Read optional api_token from cognit.yaml
const cfg = readConfig(root);
const apiToken = (cfg as { server?: { api_token?: string } }).server?.api_token;
const isLoopback = opts.host === "127.0.0.1" || opts.host === "::1" || opts.host === "localhost";
const enforceAuth = shouldEnforceAuth(apiToken, isLoopback);
if (enforceAuth) {
  process.stderr.write(
    `cognit-server: bearer auth enabled (host=${opts.host} != loopback)\n`,
  );
} else if (apiToken && isLoopback) {
  process.stderr.write(
    `cognit-server: WARNING — server.api_token is set but bind is loopback; auth is OFF (decision: no auth for the local case)\n`,
  );
}

// Build the Hono app
const app = new Hono();
app.use("*", async (c, next) => {
  // CORS for local browser dev (port 6970 UI in future phases)
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-headers", "content-type, authorization");
  c.header("access-control-allow-methods", "GET,POST,OPTIONS");
  await next();
});
app.options("*", (c) => c.body(null, 204));
if (enforceAuth) {
  app.use("/sessions/*", requireBearer({ apiToken: apiToken! }));
  app.use("/events/*", requireBearer({ apiToken: apiToken! }));
}
registerHealthz(app);
registerSessionsRoutes(app, { runtime, projectId });
registerEventsRoutes(app, { runtime, projectId });

serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }, (info) => {
  process.stdout.write(
    `cognit-server: listening on http://${info.address}:${info.port}\n`,
  );
  process.stdout.write(
    `cognit-server: project=${projectId} db=${dbPath} auth=${enforceAuth ? "bearer" : "off"}\n`,
  );
});
