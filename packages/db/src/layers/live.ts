import { Layer } from "effect";
import { EventStore, LoggerNoop } from "../context";
import { DbConnectionLive } from "../connection";
import { EventStoreLive } from "../event-store";
import { RedactorLive } from "../redaction";
import { MigrationRegistryLive } from "../migrate";
import { UuidLive } from "../ulid";
import type { DbError, DbCorrupted } from "../errors";

/**
 * The complete live Layer for the db package. Composes all services
 * needed by an application that opens a local `.cognit/cognit.db`:
 *
 *   - DbConnection     (raw handle, WAL-mode SQLite)
 *   - EventStore       (append / list / get)
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

export const DbLive = (dbPath: string): Layer.Layer<EventStore, DbError | DbCorrupted, never> =>
  Layer.provide(Layer.provide(EventStoreLive, leafs), DbConnectionLive(dbPath)) as Layer.Layer<
    EventStore,
    DbError | DbCorrupted,
    never
  >;

/** Same as `DbLive` minus the DbConnection (useful when caller provides it). */
export const DbLiveWithoutConnection = Layer.provide(EventStoreLive, leafs);

/** Test layer base: leaf deps without EventStore. */
export const DbTestBase = leafs;
