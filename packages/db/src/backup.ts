/**
 * db backup primitive — `vacuumInto(db, targetPath)`.
 *
 * SQLite's `VACUUM INTO` produces a defragmented, consistent copy
 * of the main database into a fresh file. It holds a read lock for
 * the duration of the copy but does NOT block writers from the
 * source DB's point of view (the snapshot is built from a
 * read transaction against the live WAL). The output is a clean,
 * standalone SQLite file: open it with `better-sqlite3` and
 * `integrity_check` will pass.
 *
 * Why a separate file and not just a `.dump`? `VACUUM INTO`
 * preserves schema, indexes, and pragma state (other than
 * `journal_mode`, which is reset to `delete` on the copy — fine for
 * a backup). `.dump` is text SQL and has to be replayed, which is
 * brittle across schema migrations.
 *
 * The file is committed at a caller-supplied path so the gc CLI can
 * target `cognit-backups/YYYY-MM-DD/cognit.db`. We do not mkdir
 * here — the caller is responsible for ensuring the parent
 * directory exists. (We do fail with a tagged `DbError` if the
 * directory is missing, which surfaces the misconfiguration as a
 * regular Effect error rather than an unhandled exception.)
 */
import { Effect } from "effect";
import type { Database } from "better-sqlite3";
import { DbError } from "./errors";

export const vacuumInto = (
  db: Database,
  targetPath: string,
): Effect.Effect<void, DbError> =>
  Effect.try({
    try: () => {
      // VACUUM INTO does not accept bound parameters; the path is
      // interpolated after a single-quote escape. better-sqlite3 will
      // additionally guard against anything that doesn't pass the
      // path validation, but we own the input.
      const escaped = targetPath.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${escaped}'`);
    },
    catch: (e) => new DbError({ message: `vacuumInto failed for ${targetPath}`, cause: e }),
  });
