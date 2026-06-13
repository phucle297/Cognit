/**
 * Schema migration runner.
 *
 * Migrations are ordered, idempotent, and run inside a transaction each.
 * The schema_version table stores a single row (id=1) tracking the latest
 * applied version. Migrations whose version is <= current version are
 * skipped. Running applyMigrations twice is a no-op.
 *
 * The first migration (1.0.0) creates the initial schema via TABLES_DDL;
 * future versions add new DDL or ALTER statements.
 */
import { Effect } from "effect";
import { semverGte } from "../semver";
import { TABLES_DDL } from "./tables";
import type { SqliteHandle } from "../context";
import { DbError } from "../errors";

export interface Migration {
  readonly version: string;
  readonly up: (db: SqliteHandle) => Effect.Effect<void, DbError>;
}

const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: "1.0.0",
    up: (db) =>
      Effect.try({
        try: () => {
          for (const ddl of TABLES_DDL) db.exec(ddl);
        },
        catch: (e) => new DbError({ message: `migration 1.0.0 failed: ${String(e)}`, cause: e }),
      }),
  },
];

const nowIso = (): string => new Date().toISOString();

export const applyMigrations = (
  db: SqliteHandle,
): Effect.Effect<{ applied: ReadonlyArray<string> }, DbError> =>
  Effect.gen(function* () {
    // Ensure schema_version exists so the version check below doesn't fail
    // on a fresh DB (idempotent, also covered by TABLES_DDL but needed here
    // before we read from it).
    yield* Effect.try({
      try: () =>
        db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`),
      catch: (e) => new DbError({ message: "schema_version bootstrap failed", cause: e }),
    });

    const current = db.get<{ version: string }>("SELECT version FROM schema_version WHERE id = 1");
    const currentVersion = current?.version ?? "0.0.0";
    const applied: string[] = [];

    for (const m of MIGRATIONS) {
      if (semverGte(currentVersion, m.version)) continue;

      yield* Effect.try({
        try: () => db.exec("BEGIN"),
        catch: (e) => new DbError({ message: "begin failed", cause: e }),
      });

      // Run migration; on failure rollback and rethrow (no COMMIT below)
      yield* m.up(db).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            try {
              db.exec("ROLLBACK");
            } catch {
              /* ignore */
            }
          }),
        ),
      );

      yield* Effect.try({
        try: () => db.exec("COMMIT"),
        catch: (e) => new DbError({ message: "commit failed", cause: e }),
      });

      const ts = nowIso();
      if (current) {
        db.run("UPDATE schema_version SET version = ?, applied_at = ? WHERE id = 1", [
          m.version,
          ts,
        ]);
      } else {
        db.run("INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)", [
          m.version,
          ts,
        ]);
      }
      applied.push(m.version);
    }
    return { applied };
  });
