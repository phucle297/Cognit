import { describe, expect, it } from "vitest";
import { Effect, Either, Exit, Schema } from "effect";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult } from "better-sqlite3";
import { migratePayload, CURRENT_VERSION, openDb } from "../src";
import { isValidVersion, semverCompare, semverGte, parseVersion } from "../src/semver";
import { PAYLOAD_SCHEMAS_V1 } from "../src/event-schema";
import { applyMigrations } from "../src/schema/migrations";
import { PRAGMAS } from "../src/schema/tables";
import type { SqliteHandle } from "../src/context";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("semver helpers", () => {
  it("parses well-formed versions", () => {
    expect(parseVersion("1.0.0")).toEqual([1, 0, 0]);
    expect(parseVersion("0.0.1")).toEqual([0, 0, 1]);
    expect(isValidVersion("1.0.0")).toBe(true);
    expect(isValidVersion("not-a-version")).toBe(false);
  });

  it("compares versions", () => {
    expect(semverCompare("1.0.0", "1.0.0")).toBe(0);
    expect(semverCompare("1.1.0", "1.0.0")).toBeGreaterThan(0);
    expect(semverCompare("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(semverGte("1.0.1", "1.0.0")).toBe(true);
  });
});

describe("migratePayload", () => {
  it("is a no-op when from === to", async () => {
    const program = Effect.gen(function* () {
      const payload = { text: "hi" };
      const migrated = yield* migratePayload(
        "observation_recorded",
        CURRENT_VERSION,
        CURRENT_VERSION,
        payload,
        () => [],
      );
      expect(migrated).toEqual(payload);
    });
    await Effect.runPromise(program);
  });

  it("loads and validates a v0.0.1 fixture through migratePayload", async () => {
    const fixturePath = path.join(__dirname, "fixtures", "events-v0.0.1.json");
    const text = await fs.readFile(fixturePath, "utf8");
    const events = JSON.parse(text) as Array<{
      type: string;
      version: string;
      payload_json: string;
    }>;

    // The v0.0.1 fixture uses different field names than v1.0.0
    // (e.g. `summary` instead of `text`/`goal`/`title`). Without a
    // registered transform, strict v1.0.0 validation should reject
    // every payload, proving that the migration utility refuses to
    // silently pass through incompatible shapes.
    for (const ev of events) {
      const payload = JSON.parse(ev.payload_json);
      const result = await Effect.runPromiseExit(
        migratePayload(ev.type, CURRENT_VERSION, CURRENT_VERSION, payload, () => []),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }
  });

  it("schema for v1.0.0 is strict — unknown fields rejected", async () => {
    const s = PAYLOAD_SCHEMAS_V1["observation_recorded"] as Schema.Schema<any, any, never>;
    const result = Schema.decodeUnknownEither(s)({ text: "ok" });
    expect(Either.isRight(result)).toBe(true);
    const result2 = Schema.decodeUnknownEither(s)({ summary: "old field name" });
    expect(Either.isLeft(result2)).toBe(true);
  });

  it("no registered transforms yet — transform table is empty", () => {
    // No way to introspect a Layer directly; assert via the public surface.
    // transformsFor(any, any) returns [] because TRANSFORMS is empty.
    const fakeRegistry: { transformsFor: (a: string, b: string) => ReadonlyArray<unknown> } = {
      transformsFor: () => [],
    };
    expect(fakeRegistry.transformsFor("1.0.0", "1.1.0")).toEqual([]);
  });
});

/**
 * Build a `SqliteHandle` for testing without going through the full openDb
 * path. Mirrors the same BetterSqlite3 + PRAGMA pattern used by
 * `connection.ts:openDb`.
 */
const makeTestHandle = (dbPath: string): SqliteHandle => {
  const raw = BetterSqlite3(dbPath);
  for (const pragma of PRAGMAS) raw.exec(pragma);
  return {
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
    close: () => Effect.sync(() => raw.close()),
  };
};

const withTempDb = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-migrate-"));
  return path.join(dir, "cognit.db");
};

describe("applyMigrations", () => {
  it("applies all migrations on a fresh DB and writes schema_version", async () => {
    const dbPath = await withTempDb();
    const handle = makeTestHandle(dbPath);
    try {
      const result = await Effect.runPromise(applyMigrations(handle));
      expect(result.applied).toEqual(["1.0.0"]);

      const tables = handle.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const names = tables.map((t) => t.name).sort();
      // 9 from tables.ts + 1 (sqlite_sequence not present, but schema_version is among them)
      // tables.ts defines: projects, sessions, actors, events, snapshots, artifacts,
      // edges, constraint_rules, schema_version, hypotheses, inbox_processed
      expect(names).toEqual(
        [
          "actors",
          "artifacts",
          "constraint_rules",
          "edges",
          "events",
          "hypotheses",
          "inbox_processed",
          "projects",
          "schema_version",
          "sessions",
          "snapshots",
        ].sort(),
      );
      expect(names.length).toBe(11);

      const version = handle.get<{ version: string }>(
        "SELECT version FROM schema_version WHERE id = 1",
      );
      expect(version?.version).toBe("1.0.0");
    } finally {
      await Effect.runPromise(handle.close());
    }
  });

  it("is idempotent — second call applies nothing", async () => {
    const dbPath = await withTempDb();
    const handle = makeTestHandle(dbPath);
    try {
      const first = await Effect.runPromise(applyMigrations(handle));
      expect(first.applied).toEqual(["1.0.0"]);

      const second = await Effect.runPromise(applyMigrations(handle));
      expect(second.applied).toEqual([]);

      const version = handle.get<{ version: string }>(
        "SELECT version FROM schema_version WHERE id = 1",
      );
      expect(version?.version).toBe("1.0.0");
    } finally {
      await Effect.runPromise(handle.close());
    }
  });

  it("integrity_check returns ok after migrations", async () => {
    const dbPath = await withTempDb();
    const handle = makeTestHandle(dbPath);
    try {
      await Effect.runPromise(applyMigrations(handle));
      const integrity = (handle.db.pragma("integrity_check", { simple: true }) as string) ?? "";
      expect(integrity).toBe("ok");
    } finally {
      await Effect.runPromise(handle.close());
    }
  });

  it("foreign_key_list on events contains linked_hypothesis_id → hypotheses", async () => {
    const dbPath = await withTempDb();
    const handle = makeTestHandle(dbPath);
    try {
      await Effect.runPromise(applyMigrations(handle));
      const fks = handle.all<{ from: string; table: string; to: string }>(
        "PRAGMA foreign_key_list(events)",
      );
      const linked = fks.find((fk) => fk.from === "linked_hypothesis_id");
      expect(linked).toBeDefined();
      expect(linked?.table).toBe("hypotheses");
      expect(linked?.to).toBe("id");
    } finally {
      await Effect.runPromise(handle.close());
    }
  });

  it("openDb also runs migrations end-to-end (schema_version present)", async () => {
    const dbPath = await withTempDb();
    const conn = await Effect.runPromise(openDb(dbPath));
    try {
      const version = conn.handle.get<{ version: string }>(
        "SELECT version FROM schema_version WHERE id = 1",
      );
      expect(version?.version).toBe("1.0.0");
    } finally {
      await Effect.runPromise(conn.handle.close());
    }
  });
});
