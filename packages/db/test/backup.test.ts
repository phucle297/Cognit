/**
 * Tests for the `vacuumInto` backup primitive.
 *
 * The primitive is a thin wrapper over SQLite's `VACUUM INTO`, so the
 * meaningful properties to verify are:
 *   1. A row inserted in the source DB is present in the copy.
 *   2. `integrity_check` returns `ok` on the copy.
 *   3. The copy is standalone (no -wal / -shm sidecars leaked from
 *      the source — the source's WAL is inlined on copy).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { Effect } from "effect";
import BetterSqlite3 from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { openDb } from "../src";
import { vacuumInto } from "../src/backup";

const withTempDir = (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), "cognit-backup-"));

describe("vacuumInto", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await withTempDir();
  });

  it("round-trips: insert row -> vacuumInto -> open copy -> row present", async () => {
    const srcPath = path.join(dir, "cognit.db");
    const copyPath = path.join(dir, "cognit-backup.db");
    const program = Effect.gen(function* () {
      const conn = yield* openDb(srcPath);
      conn.handle.run(`CREATE TABLE round_trip (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
      conn.handle.run(`INSERT INTO round_trip (id, label) VALUES (?, ?)`, [1, "hello"]);
      conn.handle.run(`INSERT INTO round_trip (id, label) VALUES (?, ?)`, [2, "world"]);
      yield* vacuumInto(conn.handle.db, copyPath);
    });
    await Effect.runPromise(program);

    const copy = BetterSqlite3(copyPath, { readonly: true });
    try {
      const rows = copy.prepare("SELECT id, label FROM round_trip ORDER BY id").all();
      expect(rows).toEqual([
        { id: 1, label: "hello" },
        { id: 2, label: "world" },
      ]);
    } finally {
      copy.close();
    }
  });

  it("integrity_check passes on the copy", async () => {
    const srcPath = path.join(dir, "cognit.db");
    const copyPath = path.join(dir, "cognit-copy.db");
    const program = Effect.gen(function* () {
      const conn = yield* openDb(srcPath);
      conn.handle.run(`CREATE TABLE integrity_test (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      for (let i = 0; i < 50; i++) {
        conn.handle.run(`INSERT OR REPLACE INTO integrity_test (k, v) VALUES (?, ?)`, [
          `k${i}`,
          `value-${i}-${"x".repeat(20)}`,
        ]);
      }
      yield* vacuumInto(conn.handle.db, copyPath);
    });
    await Effect.runPromise(program);

    const copy = BetterSqlite3(copyPath, { readonly: true });
    try {
      const result = copy.pragma("integrity_check", { simple: true }) as string;
      expect(result).toBe("ok");
    } finally {
      copy.close();
    }
  });

  it("copy is independent: writes to source do not affect the copy", async () => {
    const srcPath = path.join(dir, "cognit.db");
    const copyPath = path.join(dir, "cognit-iso.db");
    const program = Effect.gen(function* () {
      const conn = yield* openDb(srcPath);
      conn.handle.run(`CREATE TABLE isolation_test (id INTEGER PRIMARY KEY, val TEXT NOT NULL)`);
      conn.handle.run(`INSERT INTO isolation_test (id, val) VALUES (1, 'first')`);
      yield* vacuumInto(conn.handle.db, copyPath);
      // Mutate the source after the copy. The copy must be unaffected.
      conn.handle.run(`INSERT INTO isolation_test (id, val) VALUES (2, 'second')`);
      conn.handle.run(`UPDATE isolation_test SET val = 'mutated' WHERE id = 1`);
    });
    await Effect.runPromise(program);

    const copy = BetterSqlite3(copyPath, { readonly: true });
    try {
      const rows = copy
        .prepare("SELECT id, val FROM isolation_test ORDER BY id")
        .all() as Array<{ id: number; val: string }>;
      expect(rows).toEqual([{ id: 1, val: "first" }]);
    } finally {
      copy.close();
    }
  });

  it("fails with a tagged DbError when the target directory is missing", async () => {
    const srcPath = path.join(dir, "cognit.db");
    const badPath = path.join(dir, "does-not-exist", "backup.db");
    const program = Effect.gen(function* () {
      const conn = yield* openDb(srcPath);
      const result = yield* vacuumInto(conn.handle.db, badPath).pipe(Effect.flip);
      expect(result._tag).toBe("DbError");
      expect(result.message).toContain(badPath);
    });
    await Effect.runPromise(program);
  });
});
