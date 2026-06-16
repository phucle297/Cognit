import { Layer } from "effect";
import { DbConnection, EventStore, LoggerNoop, RedactionConfig } from "../context";
import { DbConnectionLive } from "../connection";
import { EventStoreLive } from "../event-store";
import { RedactionConfigDefault, RedactorLiveWithDefault } from "../redaction";
import { MigrationRegistryLive } from "../migrate";
import { UuidLive } from "../ulid";
import { ProjectService, ProjectServiceLive } from "../project-service";
import { SessionService, SessionServiceLive } from "../session-service";
import { SessionPolicy, SessionPolicyDefault } from "../session-policy";
import { SnapshotService, SnapshotServiceLive } from "../snapshot-service";
import { CognitionService, CognitionServiceLive } from "../cognition-service";
import { ConstraintPolicy, ConstraintPolicyLive } from "../constraint-policy";
import { EventBus } from "../bus";
import { EventBusNoop } from "../bus-noop";
import { DbSize, DbSizeLive } from "../db-size";
import { ArtifactRepo, ArtifactRepoLive } from "../artifact-repo";
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
 *   - Redactor         (built-in patterns + optional user patterns from a `RedactionConfig` layer)
 *   - MigrationRegistry (pure transforms)
 *   - Uuid             (monotonic ulid)
 *   - Logger           (no-op; replace with a structured one in prod)
 *   - EventBus         (no-op default; production swaps in EventBusLive)
 *
 * Layer composition: ONE DbConnection is built per DbLive call and
 * shared by all services. If you build `DbConnectionLive(dbPath)` more
 * than once and merge the results, each service gets its own sqlite
 * handle and the database appears empty from the others' point of
 * view. The build pattern below uses a single connection layer to
 * prevent that footgun.
 */
// `RedactorLiveWithDefault` keeps the default (empty) RedactionConfig
// satisfied so the leafs layer has a `never` R channel — callers that
// want user patterns from `cognit.yaml` plumb them via `DbLive`'s
// `redactionConfig` parameter, which rebuilds the leafs with the
// override. See `buildAppLayer` in the CLI package.
const leafs = Layer.mergeAll(RedactorLiveWithDefault, MigrationRegistryLive, UuidLive, LoggerNoop);

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
 *
 * Pass an optional `redactionConfig` to merge user patterns from
 * `cognit.yaml` (`redaction.patterns`) into the Redactor on top of
 * the built-ins; pass `undefined` to use the empty default.
 */
export const DbLive = (
  dbPath: string,
  policy: Layer.Layer<SessionPolicy> = SessionPolicyDefault,
  redactionConfig: Layer.Layer<RedactionConfig> = RedactionConfigDefault,
): Layer.Layer<
  | DbConnection
  | EventStore
  | SessionService
  | SnapshotService
  | ProjectService
  | CognitionService
  | ConstraintPolicy
  | EventBus
  | DbSize
  | ArtifactRepo,
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
  // Rebuild leafs with the caller-supplied RedactionConfig so user
  // patterns from `cognit.yaml` actually take effect. When the
  // default config is in play, this is identical to the module-level
  // `leafs` (modulo a fresh layer object).
  const localLeafs = Layer.mergeAll(
    Layer.provide(RedactorLiveWithDefault, redactionConfig),
    MigrationRegistryLive,
    UuidLive,
    LoggerNoop,
  );
  // EventStore needs DbConnection + Redactor + Uuid + Logger (leafs).
  const eventStore = Layer.provide(Layer.provide(EventStoreLive, localLeafs), dbConn);
  // SnapshotService needs DbConnection + Uuid + Logger.
  const snapshots = Layer.provide(SnapshotServiceLive, Layer.merge(localLeafs, dbConn));
  // ProjectService needs DbConnection + Uuid + Logger.
  const projects = Layer.provide(ProjectServiceLive, Layer.merge(localLeafs, dbConn));
  // DbSize and ArtifactRepo are storage helpers used by the gc CLI
  // (Phase 4 / 4c). They only need DbConnection.
  const dbSize = Layer.provide(DbSizeLive, dbConn);
  const artifactRepo = Layer.provide(ArtifactRepoLive, dbConn);
  // ConstraintPolicy needs EventStore.
  const constraintPolicy = Layer.provide(ConstraintPolicyLive, eventStore);
  // SessionService needs EventStore + SnapshotService + ConstraintPolicy
  // + leafs. After we provide eventStore and snapshots below, the only
  // remaining dep on R is from the leafs, which we already provided.
  const sessions = Layer.provide(
    Layer.provide(
      Layer.provide(SessionServiceLive, localLeafs),
      Layer.merge(Layer.merge(eventStore, snapshots), constraintPolicy),
    ),
    localLeafs,
  );
  // CognitionService sits ON TOP of SessionService (the constraint
  // chokepoint). Provide it with the SessionService layer so it lands
  // in the public Layer's output set.
  const cognition = Layer.provide(CognitionServiceLive, sessions);
  // Build a public layer providing DbConnection + the five services.
  // Using Layer.provideMerge on a Layer.merge merges the outputs and
  // satisfies the R channel — and crucially KEEPS the provided layer's
  // output in the result. `Layer.provide` alone OMITS the provided
  // layer's output (only `Layer.provideMerge` includes it), which is
  // why this used to break callers that consumed DbConnection through
  // the public layer (server tests crashed with "Service not found:
  // @cognit/db/DbConnection" even though the type signature said the
  // layer provided it — the runtime didn't). `EventBusNoop` is the
  // default bus for db-direct consumers (CLI, tests); production
  // callers (apps/server) override it with `EventBusLive` via
  // `Layer.merge`.
  const inner = Layer.mergeAll(
    eventStore,
    sessions,
    snapshots,
    projects,
    cognition,
    constraintPolicy,
    dbSize,
    artifactRepo,
    EventBusNoop,
  );
  // Provide the SessionPolicy + dbConn internally so the R channel
  // stays `never`, AND keep their outputs in the result so callers
  // can consume DbConnection and SessionPolicy through the public
  // layer. Phase 2.5b widens SessionService's R to include
  // SessionPolicy; the provide chain below satisfies that without
  // exposing the policy as a required caller dep.
  return Layer.provideMerge(Layer.provideMerge(inner, dbConn), policy) as Layer.Layer<
    | DbConnection
    | EventStore
    | SessionService
    | SessionPolicy
    | SnapshotService
    | ProjectService
    | CognitionService
    | ConstraintPolicy
    | EventBus
    | DbSize
    | ArtifactRepo,
    DbError | DbCorrupted,
    never
  >;
};

/** Test layer base: leaf deps without EventStore or SessionService. */
export const DbTestBase = leafs;
