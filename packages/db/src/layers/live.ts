import { Layer } from "effect";
import { EventStore, LoggerNoop } from "../context";
import { DbConnectionLive } from "../connection";
import { EventStoreLive } from "../event-store";
import { RedactorLive } from "../redaction";
import { MigrationRegistryLive } from "../migrate";
import { UuidLive } from "../ulid";
import { SessionService, SessionServiceLive } from "../session-service";
import { SnapshotService, SnapshotServiceLive } from "../snapshot-service";
import type { DbError, DbCorrupted } from "../errors";

/**
 * The complete live Layer for the db package. Composes all services
 * needed by an application that opens a local `.cognit/cognit.db`:
 *
 *   - DbConnection     (raw handle, WAL-mode SQLite)
 *   - EventStore       (append / list / get)
 *   - SessionService   (CRUD over `sessions` + lifecycle events)
 *   - SnapshotService  (write / latest / takeIfDue)
 *   - Redactor         (built-in patterns, no user patterns)
 *   - MigrationRegistry (pure transforms)
 *   - Uuid             (monotonic ulid)
 *   - Logger           (no-op; replace with a structured one in prod)
 *
 * Layer composition is dep-aware: each consumer's R channel is satisfied
 * by `Layer.provide`, not by `Layer.mergeAll` (which only zips outputs).
 */
const leafs = Layer.mergeAll(
  RedactorLive,
  MigrationRegistryLive,
  UuidLive,
  LoggerNoop,
);

/** Base layer: DbConnection + EventStore, deps satisfied. */
const baseLayer = (dbPath: string) =>
  Layer.provide(Layer.provide(EventStoreLive, leafs), DbConnectionLive(dbPath));

/** SnapshotServiceLive depends on DbConnection + leafs (Uuid + Logger). */
const snapshotServiceLayer = (dbPath: string) =>
  Layer.provide(
    SnapshotServiceLive,
    Layer.provide(leafs, DbConnectionLive(dbPath)),
  );

/**
 * Full live layer for the local `.cognit/cognit.db`. Provides EventStore,
 * SessionService, and SnapshotService. The Layer's R channel is `never`
 * — all deps are satisfied internally.
 *
 * SessionServiceLive now also depends on SnapshotService (for on-close
 * snapshots). We pre-build the snapshot layer and feed it to the session
 * layer's R channel, then merge all three into one.
 */
export const DbLive = (
  dbPath: string,
): Layer.Layer<
  EventStore | SessionService | SnapshotService,
  DbError | DbCorrupted,
  never
> => {
  const base = baseLayer(dbPath);
  const snapshots = snapshotServiceLayer(dbPath);
  // SessionService needs EventStore + SnapshotService + leafs.
  const sessions = Layer.provide(
    Layer.provide(SessionServiceLive, leafs),
    Layer.merge(base, snapshots),
  );
  return Layer.merge(Layer.merge(base, sessions), snapshots) as Layer.Layer<
    EventStore | SessionService | SnapshotService,
    DbError | DbCorrupted,
    never
  >;
};

/** Same as `DbLive` minus the DbConnection (useful when caller provides it). */
export const DbLiveWithoutConnection = Layer.provide(EventStoreLive, leafs);

/** Test layer base: leaf deps without EventStore or SessionService. */
export const DbTestBase = leafs;
