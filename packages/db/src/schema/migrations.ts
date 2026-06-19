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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { semverGte } from "../semver";
import { TABLES_DDL } from "./tables";
import type { SqliteHandle } from "../context";
import { DbError } from "../errors";

/**
 * Resolve `__dirname` for ESM. Migration files are loaded relative to
 * this file so the `.sql` next to `migrations.ts` is the single source
 * of truth.
 */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Read a migration file from the sibling `migrations/` directory. The
 * file is the canonical reference; this loader exposes its raw text to
 * the migration runner which feeds it to `db.exec()`.
 */
const loadMigration = (file: string): string =>
  readFileSync(join(here, "migrations", file), "utf8");

const MIGRATION_0002_SQL = loadMigration("0002_payload_v1.1.0.sql");
const MIGRATION_0003_SQL = loadMigration("0003_gravity_fired_at_v1.2.0.sql");

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
  {
    version: "1.1.0",
    up: (db) =>
      Effect.try({
        try: () => {
          // The .sql file contains multiple `;`-separated statements;
          // better-sqlite3's `exec` runs them all in one call (same
          // pattern as the 1.0.0 migration above iterating TABLES_DDL).
          db.exec(MIGRATION_0002_SQL);
        },
        catch: (e) => new DbError({ message: `migration 1.1.0 failed: ${String(e)}`, cause: e }),
      }),
  },
  {
    version: "1.2.0",
    up: (db) =>
      Effect.try({
        try: () => {
          // Phase 8 v0.2 — additive column. The schema_version gate
          // prevents re-running, but we also catch a "duplicate
          // column" error so a hand-applied DB (e.g. the dev test
          // harness) does not blow up on a second pass.
          try {
            db.exec(MIGRATION_0003_SQL);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/duplicate column name: gravity_fired_at/i.test(msg)) {
              return;
            }
            throw e;
          }
        },
        catch: (e) => new DbError({ message: `migration 1.2.0 failed: ${String(e)}`, cause: e }),
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

    let current = db.get<{ version: string }>("SELECT version FROM schema_version WHERE id = 1");
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
        // Use INSERT OR REPLACE so subsequent migrations in the same
        // run can also hit this branch when the `current` snapshot was
        // captured once before any row existed. REPLACE is safe because
        // `id` is the PRIMARY KEY and CHECK-locked to 1.
        db.run(
          "INSERT OR REPLACE INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)",
          [m.version, ts],
        );
        // The row now exists — any later migrations in this run must
        // UPDATE, not re-INSERT, to keep the id constant.
        current = { version: m.version };
      }
      applied.push(m.version);
    }
    return { applied };
  });
