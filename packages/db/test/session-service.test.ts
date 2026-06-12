import { describe, expect, it, beforeEach } from "vitest";
import { Context, Effect, Either, Layer } from "effect";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  DbConnection,
  EventStore,
  Logger,
  LoggerNoop,
  MigrationRegistryLive,
  openDb,
  RedactorLive,
  SessionService,
  SessionServiceLive,
  UuidTest,
} from "../src";
import { EventStoreLive } from "../src/event-store";
import type { SessionRow } from "../src/schema/rows";

/**
 * Test layer composing all the services the SessionService test needs.
 *
 * Layer.provide is used to satisfy R channels; Layer.merge is used to
 * combine outputs. The result provides DbConnection, EventStore, and
 * SessionService so test bodies can yield any of them.
 */
const makeTestLayer = (dbPath: string) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(
    RedactorLive,
    MigrationRegistryLive,
    UuidTest,
    LoggerNoop,
  );
  // eventStore consumes DbConnection once; dbConn is merged back in below.
  const eventStore = Layer.provide(Layer.provide(EventStoreLive, leafs), dbConn);
  // sessionService still needs DbConnection + Uuid + Logger after EventStore
  // is provided. We pass dbConn + leafs together to satisfy that R.
  const sessionService = Layer.provide(
    Layer.provide(SessionServiceLive, leafs),
    Layer.merge(eventStore, dbConn),
  );
  return Layer.merge(
    Layer.merge(eventStore, sessionService),
    Layer.merge(dbConn, LoggerNoop),
  ) as Layer.Layer<
    EventStore | DbConnection | SessionService | Logger,
    never,
    never
  >;
};

const withTempDb = (): Promise<string> =>
  fs
    .mkdtemp(path.join(os.tmpdir(), "cognit-sess-"))
    .then((dir) => path.join(dir, "cognit.db"));

const setupProject = (conn: Context.Tag.Service<typeof DbConnection>): string => {
  const projectId = "01projectxxxxxxxxxxxxxxxxx";
  conn.handle.run(
    `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
    [projectId, "test-project", new Date().toISOString()],
  );
  return projectId;
};

const ACTOR = { name: "alice", type: "human" as const };

describe("SessionService", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  const runWithLayer = <A, E, R>(
    eff: Effect.Effect<A, E, R>,
  ): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(makeTestLayer(dbPath))) as Effect.Effect<
        A,
        E,
        never
      >,
    );

  it("create inserts a sessions row and a session_created event", async () => {
    const result = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const r = yield* service.create({
          projectId,
          goal: "find the bug",
          actor: ACTOR,
        });
        return r;
      }),
    );
    expect(result.session.goal).toBe("find the bug");
    expect(result.session.status).toBe("active");
    expect(result.session.parent_session_id).toBeNull();
    expect(result.event.type).toBe("session_created");
    expect(JSON.parse(result.event.payload_json).goal).toBe("find the bug");
  });

  it("create with parentSessionId links to the parent", async () => {
    const result = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const parent = yield* service.create({
          projectId,
          goal: "parent",
          actor: ACTOR,
        });
        const child = yield* service.create({
          projectId,
          goal: "child",
          parentSessionId: parent.session.id,
          actor: ACTOR,
        });
        return { parent: parent.session, child: child.session };
      }),
    );
    expect(result.child.parent_session_id).toBe(result.parent.id);
  });

  it("create refuses an empty goal", async () => {
    await expect(
      runWithLayer(
        Effect.gen(function* () {
          const conn = yield* DbConnection;
          const service = yield* SessionService;
          const projectId = setupProject(conn);
          return yield* service.create({
            projectId,
            goal: "   ",
            actor: ACTOR,
          });
        }),
      ),
    ).rejects.toThrow();
  });

  it("list returns all sessions for a project, optionally filtered by status", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        yield* service.create({ projectId, goal: "A", actor: ACTOR });
        yield* service.create({ projectId, goal: "B", actor: ACTOR });
        const all = yield* service.list({ projectId });
        expect(all).toHaveLength(2);
        const active = yield* service.list({ projectId, status: "active" });
        expect(active).toHaveLength(2);
        const closed = yield* service.list({ projectId, status: "closed" });
        expect(closed).toHaveLength(0);
      }),
    );
  });

  it("getByGoalOrId resolves by id", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "X",
          actor: ACTOR,
        });
        const r = yield* service.getByGoalOrId({ projectId, id: created.session.id });
        expect(r.session.id).toBe(created.session.id);
        expect(r.ambiguous).toBe(false);
        expect(r.matches).toHaveLength(1);
      }),
    );
  });

  it("getByGoalOrId resolves by exact goal match", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        yield* service.create({ projectId, goal: "alpha", actor: ACTOR });
        const r = yield* service.getByGoalOrId({ projectId, goal: "alpha" });
        expect(r.session.goal).toBe("alpha");
      }),
    );
  });

  it("getByGoalOrId picks the most recent on ambiguous match and marks ambiguous", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const a = yield* service.create({ projectId, goal: "dup", actor: ACTOR });
        // sleep a millisecond so timestamps differ
        yield* Effect.sleep("2 millis");
        const b = yield* service.create({ projectId, goal: "dup", actor: ACTOR });
        const r = yield* service.getByGoalOrId({ projectId, goal: "dup" });
        expect(r.ambiguous).toBe(true);
        expect(r.matches).toHaveLength(2);
        // preferMostRecent=true is the default; b was created later
        expect(r.session.id).toBe(b.session.id);
        expect(r.session.id).not.toBe(a.session.id);
      }),
    );
  });

  it("getByGoalOrId ignores closed sessions when matching by goal", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const a = yield* service.create({ projectId, goal: "X", actor: ACTOR });
        yield* service.close(a.session.id, ACTOR);
        const b = yield* service.create({ projectId, goal: "X", actor: ACTOR });
        const r = yield* service.getByGoalOrId({ projectId, goal: "X" });
        expect(r.matches).toHaveLength(1);
        expect(r.session.id).toBe(b.session.id);
      }),
    );
  });

  it("getByGoalOrId fails on unknown id and unknown goal", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const r1 = yield* service
          .getByGoalOrId({ projectId, id: "01doesnotexist" })
          .pipe(Effect.either);
        expect(Either.isLeft(r1)).toBe(true);
        const r2 = yield* service
          .getByGoalOrId({ projectId, goal: "no-such-goal" })
          .pipe(Effect.either);
        expect(Either.isLeft(r2)).toBe(true);
      }),
    );
  });

  it("pause emits session_paused and flips status", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "P",
          actor: ACTOR,
        });
        const r = yield* service.pause(created.session.id, ACTOR);
        expect(r.session.status).toBe("paused");
        expect(r.event.type).toBe("session_paused");
      }),
    );
  });

  it("pause is a no-op on an already-paused session", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "P",
          actor: ACTOR,
        });
        yield* service.pause(created.session.id, ACTOR);
        // second pause should not throw
        const r = yield* service.pause(created.session.id, ACTOR);
        expect(r.session.status).toBe("paused");
      }),
    );
  });

  it("close emits session_closed and sets closed_at", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "C",
          actor: ACTOR,
        });
        const r = yield* service.close(created.session.id, ACTOR);
        expect(r.session.status).toBe("closed");
        expect(r.session.closed_at).not.toBeNull();
        expect(r.event.type).toBe("session_closed");
      }),
    );
  });

  it("close is a no-op on an already-closed session", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "C",
          actor: ACTOR,
        });
        yield* service.close(created.session.id, ACTOR);
        const r = yield* service.close(created.session.id, ACTOR);
        expect(r.session.status).toBe("closed");
      }),
    );
  });

  it("pause and close on an unknown session return UnknownSession", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const p1 = yield* service
          .pause("01nothere", ACTOR)
          .pipe(Effect.either);
        expect(Either.isLeft(p1)).toBe(true);
        const c1 = yield* service
          .close("01nothere", ACTOR)
          .pipe(Effect.either);
        expect(Either.isLeft(c1)).toBe(true);
      }),
    );
  });

  it("list on a project with no sessions returns an empty array", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const all = yield* service.list({ projectId });
        expect(all).toHaveLength(0);
      }),
    );
  });

  it("sessionCreatedEvent's id matches the new session row id", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const r = yield* service.create({
          projectId,
          goal: "match-id",
          actor: ACTOR,
        });
        expect(r.event.session_id).toBe(r.session.id);
        // and the event's id should equal the session id (we passed it
        // explicitly so reducer can treat the create event as the
        // canonical anchor for the session)
        expect(r.event.id).toBe(r.session.id);
      }),
    );
  });
});
