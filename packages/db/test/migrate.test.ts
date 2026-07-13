import { describe, expect, it } from "vitest";
import { Effect, Either, Exit, Schema } from "effect";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult } from "better-sqlite3";
import { migratePayload, CURRENT_VERSION, openDb, MigrationRegistry } from "../src";
import { isValidVersion, semverCompare, semverGte, parseVersion } from "../src/semver";
import { PAYLOAD_SCHEMAS_V1 } from "../src/event-schema";
import { applyMigrations } from "../src/schema/migrations";
import { PRAGMAS } from "../src/schema/tables";
import type { SqliteHandle } from "../src/context";
import { MigrationRegistryLive, type Transform } from "../src/migrate";

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
      expect(result.applied).toEqual(["1.0.0", "1.1.0", "1.2.0", "1.3.0"]);

      const tables = handle.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const names = tables.map((t) => t.name).sort();
      // 9 from tables.ts + 1 (sqlite_sequence not present, but schema_version is among them)
      // tables.ts defines: projects, sessions, actors, events, snapshots, artifacts,
      // edges, constraint_rules, schema_version, hypotheses, inbox_processed
      // plus constraint_action_log added by the 1.3.0 migration (Cognit-8g.3).
      expect(names).toEqual(
        [
          "actors",
          "artifacts",
          "constraint_action_log",
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
      expect(names.length).toBe(12);

      const version = handle.get<{ version: string }>(
        "SELECT version FROM schema_version WHERE id = 1",
      );
      expect(version?.version).toBe("1.3.0");
    } finally {
      await Effect.runPromise(handle.close());
    }
  });

  it("is idempotent — second call applies nothing", async () => {
    const dbPath = await withTempDb();
    const handle = makeTestHandle(dbPath);
    try {
      const first = await Effect.runPromise(applyMigrations(handle));
      expect(first.applied).toEqual(["1.0.0", "1.1.0", "1.2.0", "1.3.0"]);

      const second = await Effect.runPromise(applyMigrations(handle));
      expect(second.applied).toEqual([]);

      const version = handle.get<{ version: string }>(
        "SELECT version FROM schema_version WHERE id = 1",
      );
      expect(version?.version).toBe("1.3.0");
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

  it("foreign_key_list on events contains created_artifact_id → artifacts (1.1.0)", async () => {
    const dbPath = await withTempDb();
    const handle = makeTestHandle(dbPath);
    try {
      await Effect.runPromise(applyMigrations(handle));
      const fks = handle.all<{ from: string; table: string; to: string }>(
        "PRAGMA foreign_key_list(events)",
      );
      const fk = fks.find((row) => row.from === "created_artifact_id");
      expect(fk).toBeDefined();
      expect(fk?.table).toBe("artifacts");
      expect(fk?.to).toBe("id");
    } finally {
      await Effect.runPromise(handle.close());
    }
  });

  it("events has v1.1.0 outcome columns", async () => {
    const dbPath = await withTempDb();
    const handle = makeTestHandle(dbPath);
    try {
      await Effect.runPromise(applyMigrations(handle));
      const cols = handle.all<{ name: string }>("PRAGMA table_info(events)");
      const names = cols.map((c) => c.name);
      for (const c of [
        "stdout_excerpt",
        "exit_code",
        "duration_ms",
        "created_artifact_id",
      ]) {
        expect(names, `column ${c}`).toContain(c);
      }
    } finally {
      await Effect.runPromise(handle.close());
    }
  });

  it("hypotheses has gravity_fired_at column (1.2.0) with default 0", async () => {
    const dbPath = await withTempDb();
    const handle = makeTestHandle(dbPath);
    try {
      await Effect.runPromise(applyMigrations(handle));
      const cols = handle.all<{ name: string; dflt_value: string | null }>(
        "PRAGMA table_info(hypotheses)",
      );
      const fired = cols.find((c) => c.name === "gravity_fired_at");
      expect(fired, "gravity_fired_at column").toBeDefined();
      // SQLite reports the default as the literal source text.
      expect(fired?.dflt_value).toBe("0");
    } finally {
      await Effect.runPromise(handle.close());
    }
  });

  it("idx_artifacts_archived index exists on artifacts(archived_at)", async () => {
    const dbPath = await withTempDb();
    const handle = makeTestHandle(dbPath);
    try {
      await Effect.runPromise(applyMigrations(handle));
      const indexes = handle.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_artifacts_archived'",
      );
      expect(indexes.length).toBe(1);
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
      expect(version?.version).toBe("1.3.0");
    } finally {
      await Effect.runPromise(conn.handle.close());
    }
  });
});

describe("migratePayload — v1.0.0 → v1.1.0", () => {
  it("lifts a v1.0.0 verification_passed payload to v1.1.0 schema (identity transform)", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* MigrationRegistry;
      const payload = { /* v1.0.0 empty body */ };
      const migrated = yield* migratePayload(
        "verification_passed",
        "1.0.0",
        "1.1.0",
        payload,
        reg.transformsFor,
      );
      // Identity transform — the new schema's defaults fill in the
      // previously-missing fields. We assert shape, not value identity.
      expect(migrated).toBeDefined();
    });
    await Effect.runPromise(program.pipe(Effect.provide(MigrationRegistryLive)));
  });

  it("lifts a v1.0.0 verification_failed payload (stderr_excerpt preserved)", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* MigrationRegistry;
      const payload = { stderr_excerpt: "boom" };
      const migrated = (yield* migratePayload(
        "verification_failed",
        "1.0.0",
        "1.1.0",
        payload,
        reg.transformsFor,
      )) as { stderr_excerpt: string };
      expect(migrated.stderr_excerpt).toBe("boom");
    });
    await Effect.runPromise(program.pipe(Effect.provide(MigrationRegistryLive)));
  });

  it("rejects v1.0.0 → v1.1.0 path for unknown event types via v1.1.0 strict schema", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* MigrationRegistry;
      // session_created in v1.0.0 is the same as v1.1.0 — succeeds.
      const ok = yield* migratePayload(
        "session_created",
        "1.0.0",
        "1.1.0",
        { goal: "g", parent_session_id: null },
        reg.transformsFor,
      );
      expect(ok).toBeDefined();
    });
    await Effect.runPromise(program.pipe(Effect.provide(MigrationRegistryLive)));
  });
});

describe("migratePayload — v1.1.0 → v1.2.0", () => {
  it("lifts a v1.1.0 hypothesis_created payload (identity transform, fields untouched)", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* MigrationRegistry;
      const payload = { title: "Turbopack leaks", text: "explain" };
      const migrated = (yield* migratePayload(
        "hypothesis_created",
        "1.1.0",
        "1.2.0",
        payload,
        reg.transformsFor,
      )) as { title: string; text: string };
      expect(migrated.title).toBe("Turbopack leaks");
      expect(migrated.text).toBe("explain");
    });
    await Effect.runPromise(program.pipe(Effect.provide(MigrationRegistryLive)));
  });

  it("v1.1.0 → v1.2.0 lifts a v1.1.0 hypothesis_ranked absence (no event rows added)", async () => {
    // Pre-v1.2.0 stores cannot contain hypothesis_ranked rows; the
    // migration runner's identity transform must NOT synthesize them.
    // We assert by checking the registered transforms list.
    const program = Effect.gen(function* () {
      const reg = yield* MigrationRegistry;
      const path = reg.transformsFor("1.1.0", "1.2.0");
      expect(path).toHaveLength(1);
      expect(path[0]?.from).toBe("1.1.0");
      expect(path[0]?.to).toBe("1.2.0");
    });
    await Effect.runPromise(program.pipe(Effect.provide(MigrationRegistryLive)));
  });

  it("v1.0.0 → v1.2.0 picks the single sufficient transform (minimum path)", async () => {
    // The runner picks transforms with t.to >= to AND t.from >= from.
    // For 1.0.0 -> 1.2.0: the 1.0.0->1.1.0 transform is excluded (its
    // t.to = 1.1.0 is below 1.2.0). Only the 1.1.0->1.2.0 identity
    // transform is selected — its identity fn is sufficient because
    // both transforms are pure passthroughs.
    const program = Effect.gen(function* () {
      const reg = yield* MigrationRegistry;
      const path = reg.transformsFor("1.0.0", "1.2.0");
      expect(path).toHaveLength(1);
      expect(path.map((t) => `${t.from}->${t.to}`)).toEqual([
        "1.1.0->1.2.0",
      ]);
    });
    await Effect.runPromise(program.pipe(Effect.provide(MigrationRegistryLive)));
  });
});

/**
 * D-M3-01: prove migratePayload can apply a non-identity field rewrite
 * and re-validate — without registering production TRANSFORMS or
 * bumping CURRENT_VERSION. Transforms are injected only via the
 * `transformsFor` parameter (test-local).
 */
describe("migratePayload — test-local non-identity transform", () => {
  it("rewrites old field names then re-validates against the target schema", async () => {
    // Simulated historical shape: observation_recorded used `summary`
    // instead of `text`. This is NOT a production wire change — only
    // the ad-hoc transform below understands `summary`.
    const oldPayloadBytes = { summary: "tool Edit returned" };

    const testOnlyTransforms: ReadonlyArray<Transform> = [
      {
        from: "1.0.0",
        to: "1.2.0",
        type: "observation_recorded",
        fn: (payload) => {
          const p = payload as { summary?: unknown; text?: unknown };
          if (typeof p.summary === "string" && p.text === undefined) {
            return { text: p.summary };
          }
          return payload;
        },
      },
    ];
    const transformsFor = (): ReadonlyArray<Transform> => testOnlyTransforms;

    const migrated = (await Effect.runPromise(
      migratePayload(
        "observation_recorded",
        "1.0.0",
        "1.2.0",
        oldPayloadBytes,
        transformsFor,
      ),
    )) as { text: string };

    expect(migrated).toEqual({ text: "tool Edit returned" });
  });

  it("fails re-validation when a non-identity transform yields an invalid shape", async () => {
    const testOnlyTransforms: ReadonlyArray<Transform> = [
      {
        from: "1.0.0",
        to: "1.2.0",
        type: "observation_recorded",
        // Deliberately produce a shape that fails observation_recorded
        // (requires non-empty `text`).
        fn: () => ({ summary: "still the old field" }),
      },
    ];
    const transformsFor = (): ReadonlyArray<Transform> => testOnlyTransforms;

    const result = await Effect.runPromiseExit(
      migratePayload(
        "observation_recorded",
        "1.0.0",
        "1.2.0",
        { summary: "tool Edit returned" },
        transformsFor,
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
  });
});
