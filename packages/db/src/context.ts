import { Context, Effect, Layer } from "effect";
import type { Database, RunResult } from "better-sqlite3";
import type { AppendEventInput, EventRow, ListEventsQuery } from "./event-store";
import type { RedactionHit } from "./redaction";
import type { Transform } from "./migrate";
import type {
  DbError,
  NotFound,
  UnknownEventType,
  ValidationFailure,
  UnknownSession,
} from "./errors";

/**
 * Raw better-sqlite3 handle. Wrapped so the rest of the code never imports
 * the driver directly — keeping the door open to swap to libsql later.
 */
export interface SqliteHandle {
  readonly db: Database;
  readonly exec: (sql: string) => void;
  readonly run: (sql: string, params?: unknown[]) => RunResult;
  readonly get: <T = unknown>(sql: string, params?: unknown[]) => T | undefined;
  readonly all: <T = unknown>(sql: string, params?: unknown[]) => T[];
  readonly tx: <A, E>(fn: () => Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly close: () => Effect.Effect<void, never, never>;
}

export class DbConnection extends Context.Tag("@cognit/db/DbConnection")<
  DbConnection,
  { readonly handle: SqliteHandle }
>() {}

/** Redactor: scans text, returns hits (no content). */
export interface RedactorShape {
  readonly scan: (text: string) => ReadonlyArray<RedactionHit>;
  readonly scanValue: (value: unknown, path?: string) => ReadonlyArray<RedactionHit>;
  readonly redact: (text: string) => string;
  readonly redactValue: <T>(value: T) => T;
}

export class Redactor extends Context.Tag("@cognit/db/Redactor")<Redactor, RedactorShape>() {}

/** Migration registry: pure transforms between payload versions. */
export interface MigrationRegistryShape {
  readonly transformsFor: (from: string, to: string) => ReadonlyArray<Transform>;
  readonly knownVersions: (type: string) => ReadonlyArray<string>;
}

export class MigrationRegistry extends Context.Tag("@cognit/db/MigrationRegistry")<
  MigrationRegistry,
  MigrationRegistryShape
>() {}

/** High-level event store operations. */
export interface EventStoreShape {
  readonly append: (
    input: AppendEventInput,
  ) => Effect.Effect<
    EventRow,
    UnknownEventType | ValidationFailure | UnknownSession | DbError,
    never
  >;
  readonly list: (
    q: ListEventsQuery,
  ) => Effect.Effect<{ events: ReadonlyArray<EventRow>; nextCursor?: string }, never>;
  readonly get: (id: string) => Effect.Effect<EventRow, NotFound>;
}

export class EventStore extends Context.Tag("@cognit/db/EventStore")<
  EventStore,
  EventStoreShape
>() {}

/** Logger port. Defaults to a no-op for tests. */
export type LogLevel = "debug" | "info" | "warning" | "error";
export interface LoggerShape {
  readonly log: (
    level: LogLevel,
    fields: Record<string, unknown>,
    msg: string,
  ) => Effect.Effect<void>;
}

export class Logger extends Context.Tag("@cognit/db/Logger")<Logger, LoggerShape>() {}

export const LoggerNoop: Layer.Layer<Logger> = Layer.succeed(Logger)({
  log: () => Effect.void,
});

/** Convenience: the service type for a Tag. */
export type TagService<T extends Context.Tag<any, any>> = Context.Tag.Service<T>;
