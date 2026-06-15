import { Layer } from "effect";
import { DbConnection, EventStore, LoggerNoop } from "../context";
import { DbConnectionLive } from "../connection";
import { EventStoreLive } from "../event-store";
import { RedactorLive } from "../redaction";
import { MigrationRegistryLive } from "../migrate";
import { UuidLive } from "../ulid";
import { ProjectService, ProjectServiceLive } from "../project-service";
import { SessionService, SessionServiceLive } from "../session-service";
import { SessionPolicy, SessionPolicyDefault } from "../session-policy";
import { SnapshotService, SnapshotServiceLive } from "../snapshot-service";
import { CognitionService, CognitionServiceLive } from "../cognition-service";
import { ConstraintPolicy, ConstraintPolicyLive } from "../constraint-policy";
import type { DbError, DbCorrupted } from "../errors";

/**
 * The complete live Layer for the db package. Composes all services
 * needed by an application that opens a local `.cognit/cognit.db`:
 *
 *   - DbConnection     (raw handle, WAL-mode SQLite)
 *   - EventStore       (append / list / get)
 *   - SessionService   (CRUD over `sessions` + lifecycle events)
 *   - SessionPolicy    (runtime config: everyN, forkOnResume)
 *   - SnapshotService  (write / latest / takeIfDue)
 *   - ProjectService   (read + idempotent insert on `projects`)
 *   - Redactor         (built-in patterns, no user patterns)
 *   - MigrationRegistry (pure transforms)
 *   - Uuid             (monotonic ulid)
 *   - Logger           (no-op; replace with a structured one in prod)
 *
 * Layer composition: ONE DbConnection is built per DbLive call and
 * shared by all services. If you build `DbConnectionLive(dbPath)` more
 * than once and merge the results, each service gets its own sqlite
 * handle and the database appears empty from the others' point of
 * view. The build pattern below uses a single connection layer to
 * prevent that footgun.
 */
const leafs = Layer.mergeAll(RedactorLive, MigrationRegistryLive, UuidLive, LoggerNoop);

/**
 * Full live layer for the local `.cognit/cognit.db`. Provides DbConnection,
 * EventStore, SessionService, SnapshotService, ProjectService, and
 * SessionPolicy. The Layer's R channel is `never` — all deps are
 * satisfied internally. `SessionPolicy` is provided via
 * `Layer.provide` so it stays an internal dep: callers do not need to
 * satisfy it on the R channel.
 *
 * Pass an optional `policy` to override the default snapshot/resume
 * policy (e.g. from `cognit.yaml`); pass `undefined` to use
 * `SessionPolicyDefault`.
 */
export const DbLive = (
  dbPath: string,
  policy: Layer.Layer<SessionPolicy> = SessionPolicyDefault,
): Layer.Layer<
  | DbConnection
  | EventStore
  | SessionService
  | SnapshotService
  | ProjectService
  | CognitionService
  | ConstraintPolicy,
  DbError | DbCorrupted,
  never
> => {
  // Build ONE DbConnection and feed it to every service. This is the
  // critical change from the earlier pattern where each service had
  // its own connection: that pattern only worked in tests where the
  // test layer constructed its own shared `dbConn` and provided it
  // explicitly. Production code (e.g. the CLI) hits the multi-conn
  // footgun and gets "Service not found" at runtime.
  const dbConn = DbConnectionLive(dbPath);
  // EventStore needs DbConnection + Redactor + Uuid + Logger (leafs).
  const eventStore = Layer.provide(Layer.provide(EventStoreLive, leafs), dbConn);
  // SnapshotService needs DbConnection + Uuid + Logger.
  const snapshots = Layer.provide(SnapshotServiceLive, Layer.merge(leafs, dbConn));
  // ProjectService needs DbConnection + Uuid + Logger.
  const projects = Layer.provide(ProjectServiceLive, Layer.merge(leafs, dbConn));
  // ConstraintPolicy needs EventStore.
  const constraintPolicy = Layer.provide(ConstraintPolicyLive, eventStore);
  // SessionService needs EventStore + SnapshotService + ConstraintPolicy
  // + leafs. After we provide eventStore and snapshots below, the only
  // remaining dep on R is from the leafs, which we already provided.
  const sessions = Layer.provide(
    Layer.provide(
      Layer.provide(SessionServiceLive, leafs),
      Layer.merge(Layer.merge(eventStore, snapshots), constraintPolicy),
    ),
    leafs,
  );
  // CognitionService sits ON TOP of SessionService (the constraint
  // chokepoint). Provide it with the SessionService layer so it lands
  // in the public Layer's output set.
  const cognition = Layer.provide(CognitionServiceLive, sessions);
  // Build a public layer providing DbConnection + the five services.
  // We MUST include `dbConn` in the merged output set, not just provide
  // it as an input: `Layer.provide(inner, dbConn)` satisfies `inner`'s
  // R channel with `dbConn` but does NOT add `dbConn`'s outputs (i.e.
  // `DbConnection`) to the resulting layer's public outputs. The
  // `Layer.merge` below puts `dbConn` alongside the services so
  // `DbConnection` is actually exposed to callers. Without this,
  // `yield* DbConnection` after `Effect.provide(DbLive(...))` dies
  // with "Service not found" at runtime (the type cast lies — runtime
  // uses the actual layer graph, not the declared output type).
  // Build a public layer. Note: dbConn MUST be in the final merge
  // (not just as a `Layer.provide` input) so it appears in the
  // layer's public outputs. The chained `Layer.provide(inner, policy)`
  // provides dbConn to `inner`'s R channel but does not re-expose
  // DbConnection in the public output set. So we put dbConn in the
  // top-level merge below.
  const services = Layer.merge(
    Layer.merge(
      Layer.merge(
        Layer.merge(Layer.merge(eventStore, sessions), snapshots),
        projects,
      ),
      cognition,
    ),
    constraintPolicy,
  );
  // Close the R channel: services still requires `DbConnection` (from
  // `sessions` etc.) and `SessionPolicy` (from `sessions`). Use
  // `Layer.provide` (not `Layer.merge`) to satisfy those R deps —
  // `Layer.merge` only unions R channels, it does NOT propagate one
  // side's outputs to satisfy the other's R. Providing `dbConn` to
  // `services` closes `DbConnection`; then providing `policy` closes
  // `SessionPolicy`. After both provides, the layer's R is `never`.
  //
  // NOTE on the public output: `Layer.provide` CONSUMES its input
  // layer's outputs to satisfy the inner R — those outputs do NOT
  // reappear in the resulting layer's public A channel. So
  // `Layer.provide(services, dbConn)` does NOT expose `DbConnection`
  // in the public output. To re-expose it (so callers can do
  // `yield* DbConnection`), we add `dbConn` to a final `Layer.merge`
  // BELOW. The merge sees `dbConn` as a self-contained piece (R=never,
  // A=DbConnection) and unions it with the closed services layer.
  const provided = Layer.provide(
    Layer.provide(services, dbConn),
    policy,
  );
  // Final public layer: closed services + dbConn (re-exposed for
  // callers) + LoggerNoop. Order in Layer.merge is irrelevant for
  // the output union but we list dbConn first to keep it adjacent
  // to `provided` in the source.
  const finalLayer = Layer.merge(
    Layer.merge(provided, dbConn),
    LoggerNoop,
  );
  return finalLayer as Layer.Layer<
    | DbConnection
    | EventStore
    | SessionService
    | SnapshotService
    | ProjectService
    | CognitionService
    | ConstraintPolicy,
    DbError | DbCorrupted,
    never
  >;
};

/** Same as `DbLive` minus the DbConnection (useful when caller provides it). */
export const DbLiveWithoutConnection = Layer.provide(EventStoreLive, leafs);

/** Test layer base: leaf deps without EventStore or SessionService. */
export const DbTestBase = leafs;
