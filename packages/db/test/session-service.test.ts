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
  SessionPolicy,
  SessionService,
  SessionServiceLive,
  SnapshotService,
  SnapshotServiceLive,
  UuidTest,
} from "../src";
import { EventStoreLive } from "../src/event-store";
import { ConstraintPolicy, ConstraintPolicyLive } from "../src/constraint-policy";

/**
 * Test layer composing all the services the SessionService test needs.
 *
 * Layer.provide is used to satisfy R channels; Layer.merge is used to
 * combine outputs. The result provides DbConnection, EventStore,
 * SessionService, and SnapshotService so test bodies can yield any of them.
 *
 * `policyLayer` is the SessionPolicy layer to inject. Defaults to the
 * library default (everyN: 100). Tests that exercise auto-snapshot
 * thresholds pass a custom one (e.g. everyN: 3).
 */
const makeTestLayer = (
  dbPath: string,
  policyLayer: Layer.Layer<SessionPolicy> = Layer.succeed(SessionPolicy)({
    everyN: 100,
    forkOnResume: true,
  }),
) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(RedactorLive, MigrationRegistryLive, UuidTest, LoggerNoop);
  // eventStore consumes DbConnection once; dbConn is merged back in below.
  const eventStore = Layer.provide(Layer.provide(EventStoreLive, leafs), dbConn);
  // snapshotService depends on DbConnection + leafs.
  const snapshotService = Layer.provide(SnapshotServiceLive, Layer.merge(leafs, dbConn));
  // constraintPolicy depends on EventStore.
  const constraintPolicy = Layer.provide(ConstraintPolicyLive, eventStore);
  // sessionService needs EventStore + SnapshotService + ConstraintPolicy
  // + leafs + DbConnection and now also SessionPolicy.
  const sessionService = Layer.provide(
    Layer.provide(Layer.provide(SessionServiceLive, policyLayer), leafs),
    Layer.merge(
      Layer.merge(Layer.merge(eventStore, snapshotService), constraintPolicy),
      dbConn,
    ),
  );
  return Layer.merge(
    Layer.merge(
      Layer.merge(Layer.merge(eventStore, sessionService), snapshotService),
      constraintPolicy,
    ),
    Layer.merge(dbConn, LoggerNoop),
  ) as Layer.Layer<
    | EventStore
    | DbConnection
    | SessionService
    | SnapshotService
    | Logger
    | ConstraintPolicy,
    never,
    never
  >;
};

const withTempDb = (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), "cognit-sess-")).then((dir) => path.join(dir, "cognit.db"));

const setupProject = (conn: Context.Tag.Service<typeof DbConnection>): string => {
  const projectId = "01projectxxxxxxxxxxxxxxxxx";
  conn.handle.run(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`, [
    projectId,
    "test-project",
    new Date().toISOString(),
  ]);
  return projectId;
};

const ACTOR = { name: "alice", type: "human" as const };

describe("SessionService", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  const runWithLayer = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(makeTestLayer(dbPath))) as Effect.Effect<A, E, never>,
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
        const p1 = yield* service.pause("01nothere", ACTOR).pipe(Effect.either);
        expect(Either.isLeft(p1)).toBe(true);
        const c1 = yield* service.close("01nothere", ACTOR).pipe(Effect.either);
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

describe("SessionService.resume", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  const runWithLayer = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(makeTestLayer(dbPath))) as Effect.Effect<A, E, never>,
    );

  it("fork=true (default) creates a new session with parent_session_id set", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const original = yield* service.create({
          projectId,
          goal: "investigate leak",
          actor: ACTOR,
        });
        const r = yield* service.resume({
          projectId,
          idOrGoal: original.session.id,
          actor: ACTOR,
        });
        expect(r.forked).toBe(true);
        expect(r.session.id).not.toBe(original.session.id);
        expect(r.session.parent_session_id).toBe(original.session.id);
        expect(r.parent.id).toBe(original.session.id);
        expect(r.session.goal.startsWith("investigate leak (resumed ")).toBe(true);
        expect(r.event.type).toBe("session_created");
        const payload = JSON.parse(r.event.payload_json);
        expect(payload.parent_session_id).toBe(original.session.id);
      }),
    );
  });

  it("resume resolves by goal substring when not a ULID-shaped id", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        yield* service.create({ projectId, goal: "find the bug", actor: ACTOR });
        const r = yield* service.resume({
          projectId,
          idOrGoal: "find the bug",
          actor: ACTOR,
        });
        expect(r.forked).toBe(true);
        expect(r.parent.goal).toBe("find the bug");
      }),
    );
  });

  it("resume(reopen) flips status back to active and emits session_created", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const original = yield* service.create({
          projectId,
          goal: "P",
          actor: ACTOR,
        });
        yield* service.pause(original.session.id, ACTOR);
        const r = yield* service.resume({
          projectId,
          idOrGoal: original.session.id,
          fork: false,
          actor: ACTOR,
        });
        expect(r.forked).toBe(false);
        expect(r.session.id).toBe(original.session.id);
        expect(r.session.status).toBe("active");
      }),
    );
  });

  it("resume fails on a closed session (cannot fork a closed session)", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const original = yield* service.create({
          projectId,
          goal: "P",
          actor: ACTOR,
        });
        yield* service.close(original.session.id, ACTOR);
        const r = yield* service
          .resume({
            projectId,
            idOrGoal: original.session.id,
            actor: ACTOR,
          })
          .pipe(Effect.either);
        expect(Either.isLeft(r)).toBe(true);
        if (Either.isLeft(r)) {
          expect(r.left._tag).toBe("SessionAlreadyClosed");
        }
      }),
    );
  });

  it("resume fails on unknown id", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const r = yield* service
          .resume({
            projectId: "01projectxxxxxxxxxxxxxxxxx",
            idOrGoal: "01nosuchsessionhere00000",
            actor: ACTOR,
          })
          .pipe(Effect.either);
        expect(Either.isLeft(r)).toBe(true);
        if (Either.isLeft(r)) {
          expect(r.left._tag).toBe("UnknownSessionForResume");
        }
      }),
    );
  });
});

describe("SessionService.show (reducer view)", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  const runWithLayer = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(makeTestLayer(dbPath))) as Effect.Effect<A, E, never>,
    );

  it("show returns the SessionState derived from all events", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const store = yield* EventStore;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "investigate",
          actor: ACTOR,
        });
        yield* store.append({
          type: "observation_recorded",
          payload: { text: "first observation" },
          sessionId: created.session.id,
          actor: ACTOR,
        });
        yield* store.append({
          type: "observation_recorded",
          payload: { text: "second observation" },
          sessionId: created.session.id,
          actor: ACTOR,
        });
        yield* store.append({
          type: "hypothesis_created",
          payload: { title: "leak in HMR", text: "explain" },
          sessionId: created.session.id,
          actor: ACTOR,
          confidence: 0.5,
        });
        const r = yield* service.show(created.session.id);
        expect(r.state.observations).toHaveLength(2);
        expect(r.state.hypotheses.size).toBe(1);
        expect(r.state.hypotheses.get(r.state.current_hypothesis_id ?? "")?.current_state).toBe(
          "active",
        );
        expect(r.state.timeline.length).toBeGreaterThanOrEqual(4);
        expect(r.snapshot).toBeNull();
      }),
    );
  });

  it("show on an unknown session returns UnknownSession", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const r = yield* service.show("01nosuchsessionhere00000000").pipe(Effect.either);
        expect(Either.isLeft(r)).toBe(true);
      }),
    );
  });

  it("show captures rejected hypotheses and verified conclusions", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const store = yield* EventStore;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "leak",
          actor: ACTOR,
        });
        const sid = created.session.id;
        // hypothesis created + rejected
        yield* store.append({
          type: "hypothesis_created",
          payload: { title: "Turbopack", text: "leak" },
          sessionId: sid,
          actor: ACTOR,
        });
        yield* store.append({
          type: "hypothesis_rejected",
          payload: { reason_type: "evidence", superseded_by_id: null },
          sessionId: sid,
          actor: ACTOR,
        });
        // conclusion proposed + verified
        yield* store.append({
          type: "conclusion_proposed",
          payload: { text: "Turbopack is not the cause" },
          sessionId: sid,
          actor: ACTOR,
        });
        yield* store.append({
          type: "conclusion_verified",
          payload: { verification_id: "01vr", supporting_evidence_ids: ["01e1"] },
          sessionId: sid,
          actor: ACTOR,
        });
        const r = yield* service.show(sid);
        const rej = Array.from(r.state.hypotheses.values()).find(
          (h) => h.current_state === "rejected",
        );
        expect(rej).toBeDefined();
        const ver = Array.from(r.state.conclusions.values()).find((c) => c.state === "verified");
        expect(ver).toBeDefined();
        expect(ver?.verification_id).toBe("01vr");
      }),
    );
  });

  // ─── 2g: snapshot policy integration ─────────────────────────────

  it("close writes a snapshot row and updates last_snapshot_event_id", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "p",
          actor: ACTOR,
        });
        yield* service.close(created.session.id, ACTOR);

        const snap = conn.handle.get<{ event_count: number; event_id: string }>(
          "SELECT event_count, event_id FROM snapshots WHERE session_id = ?",
          [created.session.id],
        );
        expect(snap).toBeDefined();
        // session_created + session_closed = 2 events
        expect(snap?.event_count).toBe(2);

        const row = conn.handle.get<{ last_snapshot_event_id: string | null }>(
          "SELECT last_snapshot_event_id FROM sessions WHERE id = ?",
          [created.session.id],
        );
        expect(row?.last_snapshot_event_id).toBe(snap?.event_id);
      }),
    );
  });

  it("close on an already-closed session does not write a second snapshot", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "p",
          actor: ACTOR,
        });
        yield* service.close(created.session.id, ACTOR);
        // Second close: should be a no-op for snapshots
        yield* service.close(created.session.id, ACTOR);
        const count = conn.handle.get<{ n: number }>(
          "SELECT COUNT(*) as n FROM snapshots WHERE session_id = ?",
          [created.session.id],
        );
        expect(count?.n).toBe(1);
      }),
    );
  });

  it("takeSnapshot writes a new snapshot when called explicitly", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "p",
          actor: ACTOR,
        });
        const r = yield* service.takeSnapshot(created.session.id);
        expect(r.taken).toBe(true);
        expect(r.snapshot.event_count).toBe(1); // session_created only
      }),
    );
  });

  it("takeSnapshot is idempotent: second call returns existing row (taken=false)", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const conn = yield* DbConnection;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "p",
          actor: ACTOR,
        });
        const first = yield* service.takeSnapshot(created.session.id);
        expect(first.taken).toBe(true);
        const second = yield* service.takeSnapshot(created.session.id);
        expect(second.taken).toBe(false);
        expect(second.snapshot.id).toBe(first.snapshot.id);
      }),
    );
  });

  it("takeSnapshot writes a new row after more events arrive", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const store = yield* EventStore;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "p",
          actor: ACTOR,
        });
        const first = yield* service.takeSnapshot(created.session.id);
        expect(first.snapshot.event_count).toBe(1);
        // Append more events
        yield* store.append({
          type: "observation_recorded",
          payload: { text: "a" },
          sessionId: created.session.id,
          actor: ACTOR,
        });
        yield* store.append({
          type: "observation_recorded",
          payload: { text: "b" },
          sessionId: created.session.id,
          actor: ACTOR,
        });
        const second = yield* service.takeSnapshot(created.session.id);
        expect(second.taken).toBe(true);
        expect(second.snapshot.event_count).toBe(3);
        expect(second.snapshot.id).not.toBe(first.snapshot.id);
      }),
    );
  });

  it("takeSnapshot on unknown session returns UnknownSession", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const r = yield* service.takeSnapshot("01nosuchsessionhere00000").pipe(Effect.either);
        expect(r._tag).toBe("Left");
        if (r._tag === "Left") {
          expect(r.left._tag).toBe("UnknownSession");
        }
      }),
    );
  });
});

// ─── 2.5b: SessionService.appendEvent + auto-snapshot helper ──────

describe("SessionService.appendEvent (auto-snapshot)", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  const runWithLayer = <A, E, R>(
    eff: Effect.Effect<A, E, R>,
    policyLayer?: Layer.Layer<SessionPolicy>,
  ): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(makeTestLayer(dbPath, policyLayer))) as Effect.Effect<A, E, never>,
    );

  it("appendEvent happy path: returns event + snapshotTaken=false (1 < everyN)", async () => {
    const r = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "p",
          actor: ACTOR,
        });
        return yield* service.appendEvent({
          sessionId: created.session.id,
          type: "observation_recorded",
          payload: { text: "first" },
          actor: ACTOR,
        });
      }),
    );
    expect(r.event.type).toBe("observation_recorded");
    expect(r.snapshotTaken).toBe(false);
  });

  it("appendEvent below threshold: 99 appends, no snapshot row", async () => {
    const r = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "p",
          actor: ACTOR,
        });
        const sid = created.session.id;
        let lastResult: { snapshotTaken: boolean } | null = null;
        // session_created adds 1 event; append 99 more = 100 total.
        // everyN=999 keeps us well below the snapshot threshold.
        for (let i = 0; i < 99; i++) {
          lastResult = yield* service.appendEvent({
            sessionId: sid,
            type: "observation_recorded",
            payload: { text: `obs-${i}` },
            actor: ACTOR,
          });
        }
        const snapCount = conn.handle.get<{ n: number }>(
          "SELECT COUNT(*) as n FROM snapshots WHERE session_id = ?",
          [sid],
        );
        return { lastResult, snapCount };
      }),
      Layer.succeed(SessionPolicy)({ everyN: 999, forkOnResume: true }),
    );
    expect(r.lastResult?.snapshotTaken).toBe(false);
    expect(r.snapCount?.n).toBe(0);
  });

  it("appendEvent crosses threshold: 3rd append returns snapshotTaken=true and writes a snapshot row", async () => {
    const r = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "p",
          actor: ACTOR,
        });
        const sid = created.session.id;
        // everyN=3: 1st append (after session_created = 2 events) should
        // not trigger; 2nd (3 events) crosses the 3 threshold.
        const r1 = yield* service.appendEvent({
          sessionId: sid,
          type: "observation_recorded",
          payload: { text: "a" },
          actor: ACTOR,
        });
        const r2 = yield* service.appendEvent({
          sessionId: sid,
          type: "observation_recorded",
          payload: { text: "b" },
          actor: ACTOR,
        });
        const r3 = yield* service.appendEvent({
          sessionId: sid,
          type: "observation_recorded",
          payload: { text: "c" },
          actor: ACTOR,
        });
        const snap = conn.handle.get<{ event_count: number; event_id: string }>(
          "SELECT event_count, event_id FROM snapshots WHERE session_id = ?",
          [sid],
        );
        const snapCount = conn.handle.get<{ n: number }>(
          "SELECT COUNT(*) as n FROM snapshots WHERE session_id = ?",
          [sid],
        );
        return { r1, r2, r3, snap, snapCount };
      }),
      Layer.succeed(SessionPolicy)({ everyN: 3, forkOnResume: true }),
    );
    expect(r.r1.snapshotTaken).toBe(false);
    expect(r.r2.snapshotTaken).toBe(true);
    expect(r.r3.snapshotTaken).toBe(false); // 4 - 3 < 3, no new snap
    expect(r.snapCount?.n).toBe(1);
    expect(r.snap?.event_count).toBe(3);
  });

  it("appendEvent on a closed session fails with SessionClosed", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "p",
          actor: ACTOR,
        });
        yield* service.close(created.session.id, ACTOR);
        const r = yield* service
          .appendEvent({
            sessionId: created.session.id,
            type: "observation_recorded",
            payload: { text: "x" },
            actor: ACTOR,
          })
          .pipe(Effect.either);
        expect(r._tag).toBe("Left");
        if (r._tag === "Left") {
          expect(r.left._tag).toBe("SessionClosed");
        }
      }),
    );
  });

  it("appendEvent on an unknown session id fails with UnknownSession", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const r = yield* service
          .appendEvent({
            sessionId: "01nosuchsessionhere00000",
            type: "observation_recorded",
            payload: { text: "x" },
            actor: ACTOR,
          })
          .pipe(Effect.either);
        expect(r._tag).toBe("Left");
        if (r._tag === "Left") {
          expect(r.left._tag).toBe("UnknownSession");
        }
      }),
    );
  });
});

/**
 * Phase 3c: constraint engine chokepoint.
 *
 * `SessionService.appendEvent` is the single boundary through which
 * every event flows. When rules are added via `constraint_rule_added`,
 * subsequent `appendEvent` calls must evaluate the rule set against
 * the candidate event and the post-state-at-that-point; a matching
 * `block` rule must fail with `ConstraintViolation` and write nothing.
 *
 * These tests exercise that path end-to-end against a real sqlite
 * database. They share the same `makeTestLayer` shape as the
 * snapshot/reducer suites (so the layer wiring stays uniform), then
 * drive the API directly.
 */
describe("SessionService — constraint chokepoint (phase 3c)", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  const runWithLayer = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(makeTestLayer(dbPath))) as Effect.Effect<A, E, never>,
    );

  it("adds a block rule and rejects a matching observation_recorded", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const store = yield* EventStore;
        const projectId = setupProject(conn);
        const created = yield* service.create({ projectId, goal: "block obs", actor: ACTOR });
        const sessionId = created.session.id;
        yield* store.append({
          sessionId,
          type: "constraint_rule_added",
          payload: {
            rule_id: "no_obs",
            condition_json: JSON.stringify({
              kind: "event.type",
              equals: "observation_recorded",
            }),
            actions_json: JSON.stringify({ kind: "block" }),
          },
          actor: ACTOR,
        });
        const r = yield* service
          .appendEvent({
            sessionId,
            type: "observation_recorded",
            payload: { text: "should be blocked" },
            actor: ACTOR,
          })
          .pipe(Effect.either);
        expect(r._tag).toBe("Left");
        if (r._tag === "Left") {
          expect(r.left._tag).toBe("ConstraintViolation");
          const violation = r.left as { ruleId: string };
          expect(violation.ruleId).toBe("no_obs");
        }
      }),
    );
  });

  it("allows a non-matching event after adding an unrelated rule", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const store = yield* EventStore;
        const projectId = setupProject(conn);
        const created = yield* service.create({ projectId, goal: "ok", actor: ACTOR });
        const sessionId = created.session.id;
        yield* store.append({
          sessionId,
          type: "constraint_rule_added",
          payload: {
            rule_id: "block_promo",
            condition_json: JSON.stringify({
              kind: "event.type",
              equals: "hypothesis_promoted",
            }),
            actions_json: JSON.stringify({ kind: "block" }),
          },
          actor: ACTOR,
        });
        const r = yield* service.appendEvent({
          sessionId,
          type: "observation_recorded",
          payload: { text: "ok" },
          actor: ACTOR,
        });
        expect(r.event.type).toBe("observation_recorded");
      }),
    );
  });

  it("does not block adding the constraint rule itself", async () => {
    // The first constraint rule must be addable even though it would
    // have blocked an event of a future type — adding the rule is the
    // only way to start enforcing it. So the engine is excluded from
    // its own predicate set.
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({ projectId, goal: "self", actor: ACTOR });
        const sessionId = created.session.id;
        const r = yield* service
          .appendEvent({
            sessionId,
            type: "constraint_rule_added",
            payload: {
              rule_id: "r1",
              condition_json: JSON.stringify({ kind: "event.type", equals: "x" }),
              actions_json: JSON.stringify({ kind: "block" }),
            },
            actor: ACTOR,
          })
          .pipe(Effect.either);
        expect(r._tag).toBe("Right");
      }),
    );
  });

  it("no rules loaded -> any event passes", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({ projectId, goal: "no rules", actor: ACTOR });
        const r = yield* service.appendEvent({
          sessionId: created.session.id,
          type: "observation_recorded",
          payload: { text: "fine" },
          actor: ACTOR,
        });
        expect(r.event.type).toBe("observation_recorded");
      }),
    );
  });
});
