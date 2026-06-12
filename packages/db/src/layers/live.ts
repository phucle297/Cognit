import { Layer } from "effect";
import { EventStore, LoggerNoop } from "../context";
import { DbConnectionLive } from "../connection";
import { EventStoreLive } from "../event-store";
import { RedactorLive } from "../redaction";
import { MigrationRegistryLive } from "../migrate";
import { UuidLive } from "../ulid";
import { SessionService, SessionServiceLive } from "../session-service";
import type { DbError, DbCorrupted } from "../errors";

/**
 * The complete live Layer for the db package. Composes all services
 * needed by an application that opens a local `.cognit/cognit.db`:
 *
 *   - DbConnection     (raw handle, WAL-mode SQLite)
 *   - EventStore       (append / list / get)
 *   - SessionService   (CRUD over `sessions` + lifecycle events)
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

/** SessionServiceLive depends on EventStore + DbConnection + leafs. */
const sessionServiceLayer = (dbPath: string) =>
  Layer.provide(
    Layer.provide(SessionServiceLive, leafs),
    baseLayer(dbPath),
  );

/**
 * Full live layer for the local `.cognit/cognit.db`. Provides EventStore
 * and SessionService. The Layer's R channel is `never` — all deps are
 * satisfied internally.
 */
export const DbLive = (
  dbPath: string,
): Layer.Layer<EventStore | SessionService, DbError | DbCorrupted, never> => {
  const base = baseLayer(dbPath);
  const sessions = sessionServiceLayer(dbPath);
  return Layer.merge(base, sessions) as Layer.Layer<
    EventStore | SessionService,
    DbError | DbCorrupted,
    never
  >;
};

/** Same as `DbLive` minus the DbConnection (useful when caller provides it). */
export const DbLiveWithoutConnection = Layer.provide(EventStoreLive, leafs);

/** Test layer base: leaf deps without EventStore or SessionService. */
export const DbTestBase = leafs;
