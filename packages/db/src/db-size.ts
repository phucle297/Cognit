/**
 * db-size — page-count × page-size helper for storage-pressure checks.
 *
 * Phase 4 / 4c (gc CLI) uses `getDbSizeBytes` to decide whether to warn
 * (≥80% of `cleanup.max_db_size_mb`) or hard-stop (≥100%). The
 * canonical SQLite formula is `page_count * page_size`; both PRAGMAs
 * are stored as ints in the header and are stable across connections
 * to the same file (even in WAL mode, where the on-disk size includes
 * the -wal and -shm sidecars — we report the main DB only and let
 * callers add the sidecar delta if they need it).
 *
 * `getDbSizeBytes` is sync (a single `PRAGMA page_count` round-trip)
 * and Effect-wrapped so callers can compose it inside the same
 * transaction boundary as the rest of a service.
 */
import { Context, Effect, Layer } from "effect";
import { DbConnection } from "./context";
import { DbError, trySync } from "./errors";

export interface DbSizeShape {
  /** `page_count * page_size` for the main DB file. Excludes -wal/-shm. */
  readonly getDbSizeBytes: () => Effect.Effect<number, DbError>;
}

export class DbSize extends Context.Tag("@cognit/db/DbSize")<DbSize, DbSizeShape>() {}

export const DbSizeLive: Layer.Layer<DbSize, never, DbConnection> = Layer.effect(
  DbSize,
  Effect.gen(function* () {
    const conn = yield* DbConnection;
    return {
      getDbSizeBytes: () =>
        Effect.gen(function* () {
          const pageCount = yield* trySync(
            () =>
              conn.handle.get<{ "page_count": number }>("PRAGMA page_count")?.[
                "page_count"
              ] ?? 0,
            (e) => new DbError({ message: "getDbSizeBytes: page_count", cause: e }),
          );
          const pageSize = yield* trySync(
            () =>
              conn.handle.get<{ "page_size": number }>("PRAGMA page_size")?.[
                "page_size"
              ] ?? 0,
            (e) => new DbError({ message: "getDbSizeBytes: page_size", cause: e }),
          );
          return pageCount * pageSize;
        }),
    };
  }),
);
