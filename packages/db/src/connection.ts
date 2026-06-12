import { Context, Effect, Layer } from "effect";
import BetterSqlite3 from "better-sqlite3";
import type { RunResult } from "better-sqlite3";
import path from "node:path";
import fs from "node:fs/promises";
import { DbConnection, type SqliteHandle } from "./context";
import { DbCorrupted, DbError } from "./errors";
import { PRAGMAS } from "./schema/tables";
import { applyMigrations } from "./schema/migrations";

type DbConnService = Context.Tag.Service<typeof DbConnection>;

/**
 * Open a SQLite database at `dbPath`, apply pragmas, run migrations, run
 * integrity_check, and return a `DbConnection` service.
 *
 * No transactions are started here. `tx()` on the handle is what callers
 * use to scope multiple writes atomically.
 */
export const openDb = (dbPath: string): Effect.Effect<DbConnService, DbError | DbCorrupted> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => fs.mkdir(path.dirname(dbPath), { recursive: true }),
      catch: (e) => new DbError({ message: `mkdir failed for ${path.dirname(dbPath)}`, cause: e }),
    });

    const raw = yield* Effect.try({
      try: () => BetterSqlite3(dbPath),
      catch: (e) => new DbError({ message: `open failed for ${dbPath}`, cause: e }),
    });

    for (const pragma of PRAGMAS) raw.exec(pragma);

    const handle: SqliteHandle = {
      db: raw,
      exec: (sql) => raw.exec(sql),
      run: (sql, params = []) => raw.prepare(sql).run(...(params as never[])) as RunResult,
      get: <T = unknown>(sql: string, params: unknown[] = []): T | undefined =>
        raw.prepare(sql).get(...(params as never[])) as T | undefined,
      all: <T = unknown>(sql: string, params: unknown[] = []): T[] =>
        raw.prepare(sql).all(...(params as never[])) as T[],
      tx: <A, E>(fn: () => Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => raw.exec("BEGIN"));
          const result = yield* fn().pipe(
            Effect.tapError(() => Effect.sync(() => raw.exec("ROLLBACK"))),
            Effect.tap(() => Effect.sync(() => raw.exec("COMMIT"))),
          );
          return result;
        }),
      close: () =>
        Effect.try({
          try: () => {
            raw.close();
          },
          catch: (e) => new DbError({ message: "close failed", cause: e }),
        }).pipe(Effect.ignore),
    };

    yield* applyMigrations(handle);

    const integrity = (raw.pragma("integrity_check", { simple: true }) as string) ?? "";
    if (integrity !== "ok") {
      raw.close();
      return yield* Effect.fail(
        new DbCorrupted({
          message: `integrity_check returned: ${integrity}`,
          integrityCheck: String(integrity),
        }),
      );
    }

    return { handle } as DbConnService;
  });

export const DbConnectionLive = (
  dbPath: string,
): Layer.Layer<DbConnection, DbError | DbCorrupted> => Layer.effect(DbConnection, openDb(dbPath));
