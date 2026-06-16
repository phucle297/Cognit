import { describe, expect, it, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  DbConnection,
  Logger,
  LoggerNoop,
  MigrationRegistryLive,
  openDb,
  ProjectService,
  ProjectServiceLive,
  RedactorLiveWithDefault,
  resetUuidTestCounter,
  UuidTest,
} from "../src";

/**
 * Test layer for ProjectService. Depends on DbConnection + leafs.
 * No EventStore, SessionService, or SnapshotService — those are out of
 * scope for project-row tests.
 */
const makeTestLayer = (dbPath: string) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(RedactorLiveWithDefault, MigrationRegistryLive, UuidTest, LoggerNoop);
  const project = Layer.provide(ProjectServiceLive, Layer.merge(leafs, dbConn));
  return Layer.merge(project, Layer.merge(dbConn, LoggerNoop)) as Layer.Layer<
    ProjectService | DbConnection | Logger,
    never,
    never
  >;
};

const withTempDb = (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), "cognit-proj-")).then((dir) => path.join(dir, "cognit.db"));

describe("ProjectService", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
    resetUuidTestCounter();
  });

  const runWithLayer = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(makeTestLayer(dbPath))) as Effect.Effect<A, E, never>,
    );

  it("ensure inserts a new project row when none exists", async () => {
    const result = await runWithLayer(
      Effect.gen(function* () {
        const service = yield* ProjectService;
        const r = yield* service.ensure({ name: "alpha" });
        return r;
      }),
    );
    expect(result.name).toBe("alpha");
    expect(result.id).toMatch(/^01/);
    expect(result.repo_url).toBeNull();
    expect(typeof result.created_at).toBe("string");
  });

  it("ensure is idempotent: second call returns the same row", async () => {
    const result = await runWithLayer(
      Effect.gen(function* () {
        const service = yield* ProjectService;
        const a = yield* service.ensure({ name: "alpha" });
        const b = yield* service.ensure({ name: "alpha" });
        return { a, b };
      }),
    );
    expect(result.a.id).toBe(result.b.id);
    expect(result.a.created_at).toBe(result.b.created_at);
  });

  it("ensure trims whitespace from the name", async () => {
    const result = await runWithLayer(
      Effect.gen(function* () {
        const service = yield* ProjectService;
        return yield* service.ensure({ name: "  spaced  " });
      }),
    );
    expect(result.name).toBe("spaced");
  });

  it("ensure refuses an empty name", async () => {
    await expect(
      runWithLayer(
        Effect.gen(function* () {
          const service = yield* ProjectService;
          return yield* service.ensure({ name: "   " });
        }),
      ),
    ).rejects.toThrow();
  });

  it("get returns the row by id", async () => {
    const result = await runWithLayer(
      Effect.gen(function* () {
        const service = yield* ProjectService;
        const created = yield* service.ensure({ name: "alpha" });
        return yield* service.get(created.id);
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.name).toBe("alpha");
  });

  it("get returns null on an unknown id", async () => {
    const result = await runWithLayer(
      Effect.gen(function* () {
        const service = yield* ProjectService;
        return yield* service.get("01doesnotexist");
      }),
    );
    expect(result).toBeNull();
  });

  it("byName returns the row by name", async () => {
    const result = await runWithLayer(
      Effect.gen(function* () {
        const service = yield* ProjectService;
        yield* service.ensure({ name: "alpha" });
        yield* service.ensure({ name: "beta" });
        return yield* service.byName("beta");
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.name).toBe("beta");
  });

  it("byName returns null on an unknown name", async () => {
    const result = await runWithLayer(
      Effect.gen(function* () {
        const service = yield* ProjectService;
        return yield* service.byName("ghost");
      }),
    );
    expect(result).toBeNull();
  });

  it("ensure creates distinct rows for distinct names", async () => {
    const result = await runWithLayer(
      Effect.gen(function* () {
        const service = yield* ProjectService;
        const a = yield* service.ensure({ name: "alpha" });
        const b = yield* service.ensure({ name: "beta" });
        return { a, b };
      }),
    );
    expect(result.a.id).not.toBe(result.b.id);
  });
});
