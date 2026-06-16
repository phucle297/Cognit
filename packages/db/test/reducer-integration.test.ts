import { describe, expect, it, beforeEach } from "vitest";
import { Context, Effect, Layer } from "effect";
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
  RedactorLiveWithDefault,
  SessionPolicy,
  SessionService,
  SessionServiceLive,
  SnapshotService,
  SnapshotServiceLive,
  UuidTest,
} from "../src";
import { EventStoreLive } from "../src/event-store";
import { reduce } from "@cognit/core/reducer";
import { emptySessionState } from "@cognit/core/state";
import { ConstraintPolicy, ConstraintPolicyLive } from "../src/constraint-policy";

/**
 * Phase-2 done_when test.
 *
 * Builds a long, realistic event log: 14 hand-crafted events covering
 * the full state machine (observations, findings, hypothesis lifecycle,
 * experiment, conclusion, decision) plus 86 filler observation events
 * to reach 100 total — the snapshot boundary — and 5 more to exercise
 * the snapshot+tail replay path. Then closes the session (which writes
 * a second snapshot) and forks it.
 *
 * The test is the integration E2E for the whole stack:
 *   append events → snapshot at boundary → resume (snapshot+tail
 *   rebuild) → close writes second snapshot → fork creates a child
 *   session linked to the parent.
 */

/** Test layer composing the services we need for the full E2E. */
const makeTestLayer = (dbPath: string) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(RedactorLiveWithDefault, MigrationRegistryLive, UuidTest, LoggerNoop);
  // eventStore consumes DbConnection once; dbConn is merged back in below.
  const eventStore = Layer.provide(Layer.provide(EventStoreLive, leafs), dbConn);
  // snapshotService depends on DbConnection + leafs.
  const snapshotService = Layer.provide(SnapshotServiceLive, Layer.merge(leafs, dbConn));
  // constraintPolicy depends on EventStore.
  const constraintPolicy = Layer.provide(ConstraintPolicyLive, eventStore);
  // sessionService needs EventStore + SnapshotService + ConstraintPolicy
  // + leafs + DbConnection and now also SessionPolicy. Use a high
  // everyN so the auto-snapshot path doesn't trip on the manual
  // takeIfDue call inside the test.
  const policyLayer = Layer.succeed(SessionPolicy)({
    everyN: 999_999,
    forkOnResume: true,
  });
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
  fs.mkdtemp(path.join(os.tmpdir(), "cognit-redux-")).then((dir) => path.join(dir, "cognit.db"));

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

describe("reducer integration — the done_when", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  const runWithLayer = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(makeTestLayer(dbPath))) as Effect.Effect<A, E, never>,
    );

  it("appends 100+ events, snapshots, replays tail, closes, resume-as-forks", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const service = yield* SessionService;
        const snapshots = yield* SnapshotService;
        const projectId = setupProject(conn);

        // 1. Create the session. The session_created event counts as #1.
        const created = yield* service.create({
          projectId,
          goal: "investigate leak",
          actor: ACTOR,
        });
        const sessionId = created.session.id;

        // 2. Three observations.
        for (const text of ["obs-1", "obs-2", "obs-3"]) {
          yield* store.append({
            type: "observation_recorded",
            payload: { text },
            sessionId,
            actor: ACTOR,
          });
        }

        // 3. Two findings.
        yield* store.append({
          type: "finding_created",
          payload: { text: "finding-1", related_observation_ids: [] },
          sessionId,
          actor: ACTOR,
        });
        yield* store.append({
          type: "finding_created",
          payload: { text: "finding-2", related_observation_ids: [] },
          sessionId,
          actor: ACTOR,
        });

        // 4. Hypothesis lifecycle: created → weakened → rejected.
        yield* store.append({
          type: "hypothesis_created",
          payload: { title: "H1", text: "turbopack leak" },
          sessionId,
          actor: ACTOR,
          confidence: 0.5,
        });
        yield* store.append({
          type: "hypothesis_weakened",
          payload: { reason: "weaker signal than expected" },
          sessionId,
          actor: ACTOR,
          confidence: 0.3,
        });
        yield* store.append({
          type: "hypothesis_rejected",
          payload: { reason_type: "evidence", superseded_by_id: null },
          sessionId,
          actor: ACTOR,
        });

        // 5. Experiment lifecycle.
        yield* store.append({
          type: "experiment_created",
          payload: { design: "run pprof on dev server", tests_hypothesis_id: "" },
          sessionId,
          actor: ACTOR,
        });
        yield* store.append({
          type: "experiment_completed",
          payload: {
            result_summary: "pprof showed flat heap, no leak",
            supports: [],
            contradicts: [],
          },
          sessionId,
          actor: ACTOR,
        });

        // 6. Conclusion lifecycle: proposed → verified.
        yield* store.append({
          type: "conclusion_proposed",
          payload: { text: "no leak; issue is request storm" },
          sessionId,
          actor: ACTOR,
        });
        yield* store.append({
          type: "conclusion_verified",
          payload: {
            verification_id: "01vr",
            supporting_evidence_ids: ["01e1"],
          },
          sessionId,
          actor: ACTOR,
        });

        // 7. Decision lifecycle: proposed → accepted.
        yield* store.append({
          type: "decision_proposed",
          payload: {
            text: "throttle requests",
            based_on_conclusion_ids: [],
          },
          sessionId,
          actor: ACTOR,
        });
        yield* store.append({
          type: "decision_accepted",
          payload: { based_on_conclusion_ids: [] },
          sessionId,
          actor: ACTOR,
        });

        // 8. 86 filler observations to hit 100 total events.
        //    Counted: 1 (session_created) + 3 + 2 + 3 + 2 + 2 + 2 = 15. We
        //    need 100. 100 - 15 = 85 more, but we want to be exact so
        //    the snapshot boundary trips on the 100th call. Append 85
        //    more observations below.
        for (let i = 0; i < 85; i++) {
          yield* store.append({
            type: "observation_recorded",
            payload: { text: `filler-${i}` },
            sessionId,
            actor: ACTOR,
          });
        }

        // Sanity: 15 + 85 = 100 events on the wire.
        const countBefore = conn.handle.get<{ n: number }>(
          "SELECT COUNT(*) as n FROM events WHERE session_id = ?",
          [sessionId],
        );
        expect(countBefore?.n).toBe(100);

        // 9. Pre-snapshot rich state assertions. No snapshot has been
        //    taken yet, so service.show folds all events from scratch
        //    and produces a real-Map-backed state. Verify the
        //    hypothesis / decision / conclusion lifecycles are
        //    reflected in the state. After this block we take a
        //    snapshot and re-show: from then on, all show() calls go
        //    through the snapshot+tail path.
        const pre = yield* service.show(sessionId);
        expect(pre.snapshot).toBeNull();
        expect(pre.tail_event_count).toBe(100);
        expect(pre.state.observations).toHaveLength(88); // 3 + 85
        const preRejected = Array.from(pre.state.hypotheses.values()).find(
          (h) => h.current_state === "rejected",
        );
        expect(preRejected).toBeDefined();
        expect(preRejected?.title).toBe("H1");
        const preAccepted = Array.from(pre.state.decisions.values()).find(
          (d) => d.state === "accepted",
        );
        expect(preAccepted).toBeDefined();
        const preVerified = Array.from(pre.state.conclusions.values()).find(
          (c) => c.state === "verified",
        );
        expect(preVerified).toBeDefined();

        // 10. takeIfDue at the boundary.
        const snap1 = yield* snapshots.takeIfDue({
          sessionId,
          currentEventCount: 100,
          everyN: 100,
          build: (events) =>
            reduce(
              events,
              emptySessionState({
                session_id: sessionId,
                project_id: projectId,
                goal: "investigate leak",
              }),
            ),
        });
        expect(snap1).not.toBeNull();
        expect(snap1?.event_count).toBe(100);
        expect(snap1?.session_id).toBe(sessionId);

        // sessions.last_snapshot_event_id should be the 100th event's id.
        const sessionRow = conn.handle.get<{ last_snapshot_event_id: string | null }>(
          "SELECT last_snapshot_event_id FROM sessions WHERE id = ?",
          [sessionId],
        );
        expect(sessionRow?.last_snapshot_event_id).toBe(snap1?.event_id);

        // 11. Append 5 more events (the "tail"), then show: the
        //     snapshot+tail path is exercised because r.snapshot is
        //     populated and tail_event_count is 5.
        for (let i = 0; i < 5; i++) {
          yield* store.append({
            type: "observation_recorded",
            payload: { text: `tail-${i}` },
            sessionId,
            actor: ACTOR,
          });
        }
        const r = yield* service.show(sessionId);
        // tail_event_count == 5 means exactly 5 events were folded
        // after the snapshot, so timeline.length is the snapshot's
        // serialized timeline of 100 plus the 5 tail events = 105.
        expect(r.tail_event_count).toBe(5);
        expect(r.snapshot).not.toBeNull();
        expect(r.snapshot?.event_count).toBe(100);
        expect(r.state.timeline.length).toBe(105);

        // The timeline on the snapshot+tail path must contain the 5
        // tail observation events we just appended (in addition to
        // whatever the snapshot's serialized state had).
        const tailTexts = r.state.timeline.slice(-5).map((e) => JSON.parse(e.payload_json).text);
        expect(tailTexts).toEqual(["tail-0", "tail-1", "tail-2", "tail-3", "tail-4"]);

        // Rich state assertions on the snapshot+tail path. Before the
        // serializeState Map-roundtrip fix, these would have returned
        // empty Maps (snapshot.state_json had `{}` for the Map fields)
        // and the assertions would have failed.
        const postRejected = Array.from(r.state.hypotheses.values()).find(
          (h) => h.current_state === "rejected",
        );
        expect(postRejected).toBeDefined();
        expect(postRejected?.title).toBe("H1");
        const postAccepted = Array.from(r.state.decisions.values()).find(
          (d) => d.state === "accepted",
        );
        expect(postAccepted).toBeDefined();
        const postVerified = Array.from(r.state.conclusions.values()).find(
          (c) => c.state === "verified",
        );
        expect(postVerified).toBeDefined();
        // The 88 observations (3 hand-built + 85 filler) plus 5 tail
        // observations are also visible in the rich state — proves the
        // tail is folded on top of the snapshot's serialized
        // observations list.
        expect(r.state.observations).toHaveLength(93);

        // 12. Close: this also writes a second snapshot. After close the
        //     state should reflect status=closed and a newer snapshot row.
        yield* service.close(sessionId, ACTOR);
        const allSnaps = conn.handle.all<{ id: string; event_count: number }>(
          "SELECT id, event_count FROM snapshots WHERE session_id = ? ORDER BY event_count ASC",
          [sessionId],
        );
        expect(allSnaps).toHaveLength(2);
        expect(allSnaps[0]?.event_count).toBe(100);
        // The close path appends a session_closed event (the 106th),
        // then writes a snapshot at event_count=106 — covering
        // everything including the close.
        expect(allSnaps[1]?.event_count).toBe(106);

        const closed = conn.handle.get<{ status: string; closed_at: string | null }>(
          "SELECT status, closed_at FROM sessions WHERE id = ?",
          [sessionId],
        );
        expect(closed?.status).toBe("closed");
        expect(closed?.closed_at).not.toBeNull();

        // 13. resume --fork=true on a closed session: per the contract
        //     SessionAlreadyClosed is returned (closed sessions cannot
        //     be forked from). This locks the contract that fork
        //     only operates on active/paused sessions.
        const forkResult = yield* service
          .resume({
            projectId,
            idOrGoal: sessionId,
            actor: ACTOR,
          })
          .pipe(Effect.either);
        expect(forkResult._tag).toBe("Left");
        if (forkResult._tag === "Left") {
          expect(forkResult.left._tag).toBe("SessionAlreadyClosed");
        }
      }),
    );
  });

  it("resume-as-fork on an active session creates a child linked to the parent", async () => {
    // Companion to the done_when test: a fork flow that does not hit
    // the SessionAlreadyClosed path, so the parent_session_id
    // assertion is exercised against a live resume.
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const original = yield* service.create({
          projectId,
          goal: "investigate",
          actor: ACTOR,
        });
        // Fork the active session. The forked session should have
        // parent_session_id === original.id and the
        // session_created event payload should carry the parent link.
        const r = yield* service.resume({
          projectId,
          idOrGoal: original.session.id,
          actor: ACTOR,
        });
        expect(r.forked).toBe(true);
        expect(r.session.parent_session_id).toBe(original.session.id);
        const payload = JSON.parse(r.event.payload_json);
        expect(payload.parent_session_id).toBe(original.session.id);
      }),
    );
  });
});

/**
 * Phase 2.5: a sibling describe that uses everyN=3 to exercise the
 * auto-snapshot trigger path on SessionService.appendEvent end-to-end.
 * Mirrors the policy behaviour a project with
 * `session.snapshot_every_n_events: 3` in cognit.yaml would get.
 */
describe("reducer integration — auto-snapshot trigger", () => {
  // Custom layer factory with everyN=3.
  const makeAutoSnapLayer = (dbPath: string) => {
    const dbConn = Layer.effect(DbConnection, openDb(dbPath));
    const leafs = Layer.mergeAll(RedactorLiveWithDefault, MigrationRegistryLive, UuidTest, LoggerNoop);
    const eventStore = Layer.provide(Layer.provide(EventStoreLive, leafs), dbConn);
    const snapshotService = Layer.provide(SnapshotServiceLive, Layer.merge(leafs, dbConn));
    const constraintPolicy = Layer.provide(ConstraintPolicyLive, eventStore);
    const policyLayer = Layer.succeed(SessionPolicy)({
      everyN: 3,
      forkOnResume: true,
    });
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

  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  const runWithLayer = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(makeAutoSnapLayer(dbPath))) as Effect.Effect<A, E, never>,
    );

  it("writes auto-snapshots at event_count=3 and event_count=6 when everyN=3", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "auto-snap",
          actor: ACTOR,
        });
        const sid = created.session.id;

        // Append 5 events (session_created is #1, so total count=6).
        for (let i = 0; i < 5; i++) {
          yield* service.appendEvent({
            sessionId: sid,
            type: "observation_recorded",
            payload: { text: `obs-${i}` },
            actor: ACTOR,
          });
        }

        // After 5 appends: session_created + 5 = 6 total events.
        // everyN=3: snapshot at count=3, next at count=6 (6-3=3).
        const snaps = conn.handle.all<{ event_count: number }>(
          "SELECT event_count FROM snapshots WHERE session_id = ? ORDER BY event_count ASC",
          [sid],
        );
        expect(snaps).toHaveLength(2);
        expect(snaps[0]?.event_count).toBe(3);
        expect(snaps[1]?.event_count).toBe(6);

        // last_snapshot_event_id points to the 6th event (the latest).
        const sessionRow = conn.handle.get<{ last_snapshot_event_id: string | null }>(
          "SELECT last_snapshot_event_id FROM sessions WHERE id = ?",
          [sid],
        );
        expect(sessionRow?.last_snapshot_event_id).not.toBeNull();
      }),
    );
  });
});
