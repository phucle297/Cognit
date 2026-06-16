/**
 * Tests for the storage-GC helpers added in Phase 4 / 4c:
 *   - DbSize.getDbSizeBytes
 *   - ArtifactRepo.listArtifacts / markArtifactArchived
 *
 * The artifact table is created by migration 1.0.0; we insert rows
 * directly via the raw handle (no event-store path) to keep the test
 * isolated from the chokepoint.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  ArtifactRepo,
  DbConnection,
  DbSize,
  LoggerNoop,
  MigrationRegistryLive,
  RedactorLiveWithDefault,
  UuidTest,
  openDb,
} from "../src";
import { ArtifactRepoLive } from "../src/artifact-repo";
import { DbSizeLive } from "../src/db-size";

const withTempDb = (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), "cognit-dbhelper-")).then((dir) =>
    path.join(dir, "cognit.db"),
  );

const seedArtifact = (
  conn: { handle: { run: (sql: string, params?: unknown[]) => unknown } },
  row: {
    id: string;
    sessionId: string;
    path: string;
    kind: string;
    sha256: string;
    sizeBytes: number | null;
    archivedAt: string | null;
    createdAt: string;
  },
): void => {
  conn.handle.run(
    `INSERT INTO artifacts (id, session_id, path, kind, sha256, size_bytes, archived_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.sessionId,
      row.path,
      row.kind,
      row.sha256,
      row.sizeBytes,
      row.archivedAt,
      row.createdAt,
    ],
  );
};

const isoMinusDays = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

/**
 * Seed a project + session row so the artifacts FK (`session_id` ->
 * `sessions.id`) is satisfied. The test database starts empty; every
 * artifact insertion must run after this.
 */
const seedProjectAndSession = (
  conn: { handle: { run: (sql: string, params?: unknown[]) => unknown } },
  projectId = "01projectxxxxxxxxxxxxxxxxx",
  sessionId = "01sessionxxxxxxxxxxxxxxxxx",
): void => {
  conn.handle.run(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`, [
    projectId,
    "db-helper-test",
    new Date().toISOString(),
  ]);
  conn.handle.run(
    `INSERT INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    [sessionId, projectId, "test", "active", new Date().toISOString()],
  );
};

const buildLayer = (dbPath: string) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(
    RedactorLiveWithDefault,
    MigrationRegistryLive,
    UuidTest,
    LoggerNoop,
  );
  return Layer.merge(
    Layer.merge(
      Layer.provide(ArtifactRepoLive, dbConn),
      Layer.provide(DbSizeLive, dbConn),
    ),
    Layer.merge(dbConn, leafs),
  ) as Layer.Layer<DbSize | ArtifactRepo | DbConnection, never, never>;
};

describe("DbSize.getDbSizeBytes", () => {
  let dbPath: string;
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  it("matches PRAGMA page_count * page_size", async () => {
    const program = Effect.gen(function* () {
      const dbSize = yield* DbSize;
      const conn = yield* DbConnection;
      const reported = yield* dbSize.getDbSizeBytes();
      const pageCount =
        conn.handle.get<{ page_count: number }>("PRAGMA page_count")?.page_count ?? 0;
      const pageSize =
        conn.handle.get<{ page_size: number }>("PRAGMA page_size")?.page_size ?? 0;
      expect(reported).toBe(pageCount * pageSize);
      // sanity: fresh DB has at least one page
      expect(reported).toBeGreaterThan(0);
    });
    await Effect.runPromise(program.pipe(Effect.provide(buildLayer(dbPath))));
  });

  it("grows after inserting many rows", async () => {
    const program = Effect.gen(function* () {
      const dbSize = yield* DbSize;
      const conn = yield* DbConnection;
      const before = yield* dbSize.getDbSizeBytes();
      // Project + 200 sessions — large enough to force at least one
      // page growth on the main DB file.
      conn.handle.run(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`, [
        "01projectxxxxxxxxxxxxxxxxx",
        "size-test",
        new Date().toISOString(),
      ]);
      const insertSession = conn.handle.db.prepare(
        `INSERT INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
      );
      const tx = conn.handle.db.transaction((n: number) => {
        for (let i = 0; i < n; i++) {
          insertSession.run(
            `01s${i.toString().padStart(24, "0")}xx`,
            "01projectxxxxxxxxxxxxxxxxx",
            "g",
            "active",
            new Date().toISOString(),
          );
        }
      });
      tx(200);
      const after = yield* dbSize.getDbSizeBytes();
      expect(after).toBeGreaterThan(before);
    });
    await Effect.runPromise(program.pipe(Effect.provide(buildLayer(dbPath))));
  });
});

describe("ArtifactRepo", () => {
  let dbPath: string;
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  it("listArtifacts filters out archived rows by default", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* ArtifactRepo;
      const conn = yield* DbConnection;
      seedProjectAndSession(conn);
      seedArtifact(conn, {
        id: "01alivexxxxxxxxxxxxxxxxxxx",
        sessionId: "01sessionxxxxxxxxxxxxxxxxx",
        path: "/a",
        kind: "log",
        sha256: "x",
        sizeBytes: 1,
        archivedAt: null,
        createdAt: isoMinusDays(1),
      });
      seedArtifact(conn, {
        id: "01deadxxxxxxxxxxxxxxxxxxx",
        sessionId: "01sessionxxxxxxxxxxxxxxxxx",
        path: "/b",
        kind: "log",
        sha256: "y",
        sizeBytes: 2,
        archivedAt: isoMinusDays(2),
        createdAt: isoMinusDays(3),
      });
      const live = yield* repo.listArtifacts({});
      expect(live.map((r) => r.id)).toEqual(["01alivexxxxxxxxxxxxxxxxxxx"]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(buildLayer(dbPath))));
  });

  it("listArtifacts({ archived: true }) includes archived rows", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* ArtifactRepo;
      const conn = yield* DbConnection;
      seedProjectAndSession(conn);
      seedArtifact(conn, {
        id: "01alivexxxxxxxxxxxxxxxxxxx",
        sessionId: "01sessionxxxxxxxxxxxxxxxxx",
        path: "/a",
        kind: "log",
        sha256: "x",
        sizeBytes: 1,
        archivedAt: null,
        createdAt: isoMinusDays(1),
      });
      seedArtifact(conn, {
        id: "01deadxxxxxxxxxxxxxxxxxxx",
        sessionId: "01sessionxxxxxxxxxxxxxxxxx",
        path: "/b",
        kind: "log",
        sha256: "y",
        sizeBytes: 2,
        archivedAt: isoMinusDays(2),
        createdAt: isoMinusDays(3),
      });
      const all = yield* repo.listArtifacts({ archived: true });
      expect(all.map((r) => r.id).sort()).toEqual([
        "01alivexxxxxxxxxxxxxxxxxxx",
        "01deadxxxxxxxxxxxxxxxxxxx",
      ]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(buildLayer(dbPath))));
  });

  it("listArtifacts filters by sessionId", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* ArtifactRepo;
      const conn = yield* DbConnection;
      // Two sessions, one artifact each — listArtifacts({ sessionId })
      // must scope to the requested one.
      conn.handle.run(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`, [
        "01projectxxxxxxxxxxxxxxxxx",
        "db-helper-test",
        new Date().toISOString(),
      ]);
      conn.handle.run(
        `INSERT INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
        ["01s1xxxxxxxxxxxxxxxxxxxxxx", "01projectxxxxxxxxxxxxxxxxx", "t", "active", new Date().toISOString()],
      );
      conn.handle.run(
        `INSERT INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
        ["01s2xxxxxxxxxxxxxxxxxxxxxx", "01projectxxxxxxxxxxxxxxxxx", "t", "active", new Date().toISOString()],
      );
      seedArtifact(conn, {
        id: "01s1xxxxxxxxxxxxxxxxxxxxxx",
        sessionId: "01s1xxxxxxxxxxxxxxxxxxxxxx",
        path: "/a",
        kind: "log",
        sha256: "x",
        sizeBytes: 1,
        archivedAt: null,
        createdAt: isoMinusDays(1),
      });
      seedArtifact(conn, {
        id: "01s2xxxxxxxxxxxxxxxxxxxxxx",
        sessionId: "01s2xxxxxxxxxxxxxxxxxxxxxx",
        path: "/b",
        kind: "log",
        sha256: "y",
        sizeBytes: 2,
        archivedAt: null,
        createdAt: isoMinusDays(1),
      });
      const s1 = yield* repo.listArtifacts({ sessionId: "01s1xxxxxxxxxxxxxxxxxxxxxx" });
      expect(s1.map((r) => r.id)).toEqual(["01s1xxxxxxxxxxxxxxxxxxxxxx"]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(buildLayer(dbPath))));
  });

  it("listArtifacts filters by olderThanDays", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* ArtifactRepo;
      const conn = yield* DbConnection;
      seedProjectAndSession(conn);
      seedArtifact(conn, {
        id: "01oldxxxxxxxxxxxxxxxxxxxxx",
        sessionId: "01sessionxxxxxxxxxxxxxxxxx",
        path: "/old",
        kind: "log",
        sha256: "x",
        sizeBytes: 1,
        archivedAt: null,
        createdAt: isoMinusDays(30),
      });
      seedArtifact(conn, {
        id: "01newxxxxxxxxxxxxxxxxxxxxx",
        sessionId: "01sessionxxxxxxxxxxxxxxxxx",
        path: "/new",
        kind: "log",
        sha256: "y",
        sizeBytes: 1,
        archivedAt: null,
        createdAt: isoMinusDays(1),
      });
      const stale = yield* repo.listArtifacts({ olderThanDays: 7 });
      expect(stale.map((r) => r.id)).toEqual(["01oldxxxxxxxxxxxxxxxxxxxxx"]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(buildLayer(dbPath))));
  });

  it("markArtifactArchived sets the column and is idempotent", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* ArtifactRepo;
      const conn = yield* DbConnection;
      seedProjectAndSession(conn);
      seedArtifact(conn, {
        id: "01markxxxxxxxxxxxxxxxxxxxx",
        sessionId: "01sessionxxxxxxxxxxxxxxxxx",
        path: "/m",
        kind: "log",
        sha256: "x",
        sizeBytes: 1,
        archivedAt: null,
        createdAt: isoMinusDays(1),
      });
      const ts = new Date().toISOString();
      const first = yield* repo.markArtifactArchived("01markxxxxxxxxxxxxxxxxxxxx", ts);
      expect(first).toBe(1);
      // Second call updates 0 rows because the row is no longer in the
      // default `archived = false` set, but the call itself is allowed.
      const second = yield* repo.markArtifactArchived("01markxxxxxxxxxxxxxxxxxxxx", ts);
      expect(second).toBe(0);
      const row = conn.handle.get<{ archived_at: string | null }>(
        "SELECT archived_at FROM artifacts WHERE id = ?",
        ["01markxxxxxxxxxxxxxxxxxxxx"],
      );
      expect(row?.archived_at).toBe(ts);
    });
    await Effect.runPromise(program.pipe(Effect.provide(buildLayer(dbPath))));
  });

  it("markArtifactArchived returns 0 for unknown id", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* ArtifactRepo;
      const out = yield* repo.markArtifactArchived(
        "01nopeexxxxxxxxxxxxxxxxxxxx",
        new Date().toISOString(),
      );
      expect(out).toBe(0);
    });
    await Effect.runPromise(program.pipe(Effect.provide(buildLayer(dbPath))));
  });

  it("deleteArtifact removes the row and returns 0 for unknown id", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* ArtifactRepo;
      const conn = yield* DbConnection;
      seedProjectAndSession(conn);
      seedArtifact(conn, {
        id: "01delxxxxxxxxxxxxxxxxxxxxx",
        sessionId: "01sessionxxxxxxxxxxxxxxxxx",
        path: "/d",
        kind: "log",
        sha256: "x",
        sizeBytes: 1,
        archivedAt: null,
        createdAt: isoMinusDays(1),
      });
      const first = yield* repo.deleteArtifact("01delxxxxxxxxxxxxxxxxxxxxx");
      expect(first).toBe(1);
      const second = yield* repo.deleteArtifact("01delxxxxxxxxxxxxxxxxxxxxx");
      expect(second).toBe(0);
      const unknown = yield* repo.deleteArtifact("01nopeexxxxxxxxxxxxxxxxxxxx");
      expect(unknown).toBe(0);
    });
    await Effect.runPromise(program.pipe(Effect.provide(buildLayer(dbPath))));
  });
});
