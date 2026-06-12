/**
 * @cognit/db — append-only event store with redaction, idempotency, and
 * Effect-native service boundaries.
 *
 * Public surface:
 *   - Tags: DbConnection, EventStore, SessionService, Redactor,
 *     MigrationRegistry, Uuid, Logger
 *   - Live layers: DbLive(dbPath), DbTestBase
 *   - Errors: tagged union in `./errors`
 *   - Helpers: openDb, makeRedactor, migratePayload, redactEvent,
 *     CURRENT_VERSION, EVENT_TYPES
 */

export * from "./context";
export * from "./errors";
export * from "./event-schema";
export * from "./migrate";
export * from "./semver";
export * from "./ulid";
export * from "./redaction";
export * from "./event-store";
export * from "./inbox";
export * from "./connection";
export * from "./session-service";
export * from "./layers/live";
export * from "./schema/rows";
export * from "./schema/migrations";
export * from "./actor";
