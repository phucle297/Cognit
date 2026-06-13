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
  DbConnection | EventStore | SessionService | SnapshotService | ProjectService,
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
  // SessionService needs EventStore + SnapshotService + leafs.
  // After we provide eventStore and snapshots below, the only
  // remaining dep on R is from the leafs, which we already provided.
  const sessions = Layer.provide(
    Layer.provide(Layer.provide(SessionServiceLive, leafs), Layer.merge(eventStore, snapshots)),
    leafs,
  );
  // Build a public layer providing DbConnection + the four services.
  // Using Layer.provide on a Layer.merge merges the outputs and
  // satisfies the R channel.
  const inner = Layer.merge(Layer.merge(Layer.merge(eventStore, sessions), snapshots), projects);
  // Provide the SessionPolicy internally so the R channel stays
  // `never`. Phase 2.5b widens SessionService's R to include
  // SessionPolicy; the provide chain below satisfies that without
  // exposing the policy to callers.
  return Layer.provide(Layer.provide(inner, dbConn), policy) as Layer.Layer<
    DbConnection | EventStore | SessionService | SnapshotService | ProjectService,
    DbError | DbCorrupted,
    never
  >;
};

/** Same as `DbLive` minus the DbConnection (useful when caller provides it). */
export const DbLiveWithoutConnection = Layer.provide(EventStoreLive, leafs);

/** Test layer base: leaf deps without EventStore or SessionService. */
export const DbTestBase = leafs;
