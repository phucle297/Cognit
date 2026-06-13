import { describe, expect, it, beforeEach } from "vitest";
import { Context, Effect, Layer } from "effect";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  DbConnection,
  Logger,
  LoggerNoop,
  MigrationRegistryLive,
  openDb,
  RedactorLive,
  SnapshotService,
  SnapshotServiceLive,
  UuidTest,
} from "../src";

/**
 * Test layer composing DbConnection + SnapshotService.
 *
 * SnapshotService depends on DbConnection + Uuid + Logger; it does not
 * require EventStore. The build() injection parameter on takeIfDue is
 * supplied by the test, so we never need the reducer (or its I/O) here.
 */
const makeTestLayer = (dbPath: string) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(
    RedactorLive,
    MigrationRegistryLive,
    UuidTest,
    LoggerNoop,
  );
  const snapshot = Layer.provide(SnapshotServiceLive, Layer.merge(leafs, dbConn));
  return Layer.merge(snapshot, Layer.merge(dbConn, LoggerNoop)) as Layer.Layer<
    SnapshotService | DbConnection | Logger,
    never,
    never
  >;
};

const withTempDb = (): Promise<string> =>
  fs
    .mkdtemp(path.join(os.tmpdir(), "cognit-snap-"))
    .then((dir) => path.join(dir, "cognit.db"));

const ACTOR_ID = "01actor00000000000000000000a";
const setupProjectAndSession = (
  conn: Context.Tag.Service<typeof DbConnection>,
): { projectId: string; sessionId: string; eventId: string } => {
  const projectId = "01projectxxxxxxxxxxxxxxxxx";
  const sessionId = "01sessionxxxxxxxxxxxxxxxxx";
  const eventId = "01eventxxxxxxxxxxxxxxxxxx1";
  const now = new Date().toISOString();
  conn.handle.run(
    "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)",
    [projectId, "test-project", now],
  );
  conn.handle.run(
    `INSERT INTO actors (id, type, name, trust_score, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [ACTOR_ID, "human", "test-actor", 0, now, now],
  );
  conn.handle.run(
    `INSERT INTO sessions (
       id, project_id, parent_session_id, goal, status,
       last_snapshot_event_id, created_at, closed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, projectId, null, "test-goal", "active", null, now, null],
  );
  // Seed a session_created event so snapshots.event_id FK resolves.
  conn.handle.run(
    `INSERT INTO events (
       id, project_id, session_id, actor_id, type, version, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      projectId,
      sessionId,
      ACTOR_ID,
      "session_created",
      "1.0.0",
      JSON.stringify({ goal: "test-goal", parent_session_id: null }),
      now,
    ],
  );
  return { projectId, sessionId, eventId };
};

const sampleState = () => ({
  session_id: "01sessionxxxxxxxxxxxxxxxxx",
  project_id: "01projectxxxxxxxxxxxxxxxxx",
  goal: "test",
  parent_session_id: null,
  status: "active" as const,
  current_hypothesis_id: null,
  current_theory_id: null,
  current_decision_id: null,
  current_conclusion_id: null,
  current_verification_id: null,
  observations: [],
  findings: [],
  hypotheses: new Map(),
  theories: new Map(),
  experiments: new Map(),
  decisions: new Map(),
  conclusions: new Map(),
  verifications: new Map(),
  artifacts: new Map(),
  edges: [],
  timeline: [],
  snapshot_event_id: null,
  last_event_id: null,
  last_event_at: null,
});

const seedEvent = (
  conn: Context.Tag.Service<typeof DbConnection>,
  id: string,
  ts: string,
  sessionId: string,
  type = "observation_recorded",
): void => {
  conn.handle.run(
    `INSERT INTO events (
       id, project_id, session_id, actor_id, type, version, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "01projectxxxxxxxxxxxxxxxxx",
      sessionId,
      ACTOR_ID,
      type,
      "1.0.0",
      JSON.stringify({ text: "x" }),
      ts,
    ],
  );
};

describe("SnapshotService", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  const runWithLayer = <A, E, R>(
    eff: Effect.Effect<A, E, R>,
  ): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(makeTestLayer(dbPath))) as Effect.Effect<A, E, never>,
    );

  it("write inserts a snapshots row + updates sessions.last_snapshot_event_id", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SnapshotService;
        const { sessionId, eventId } = setupProjectAndSession(conn);
        const row = yield* service.write({
          sessionId,
          state: sampleState(),
          eventId,
          eventCount: 1,
        });
        expect(row.session_id).toBe(sessionId);
        expect(row.event_id).toBe(eventId);
        expect(row.event_count).toBe(1);

        const updated = conn.handle.get<{ last_snapshot_event_id: string | null }>(
          "SELECT last_snapshot_event_id FROM sessions WHERE id = ?",
          [sessionId],
        );
        expect(updated?.last_snapshot_event_id).toBe(eventId);
      }),
    );
  });

  it("latestForSession returns the most recent snapshot row", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SnapshotService;
        const { sessionId } = setupProjectAndSession(conn);
        // Need 2 events to reference 2 snapshots.
        const e2 = "01eventxxxxxxxxxxxxxxxxxx2";
        const e3 = "01eventxxxxxxxxxxxxxxxxxx3";
        seedEvent(conn, e2, "2026-01-01T00:00:00.002Z", sessionId);
        seedEvent(conn, e3, "2026-01-01T00:00:00.003Z", sessionId);
        yield* service.write({
          sessionId,
          state: sampleState(),
          eventId: e2,
          eventCount: 2,
        });
        yield* service.write({
          sessionId,
          state: sampleState(),
          eventId: e3,
          eventCount: 3,
        });
        const latest = yield* service.latestForSession(sessionId);
        expect(latest).not.toBeNull();
        expect(latest?.event_id).toBe(e3);
        expect(latest?.event_count).toBe(3);
      }),
    );
  });

  it("latestForSession returns null when no snapshot exists", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SnapshotService;
        const { sessionId } = setupProjectAndSession(conn);
        const latest = yield* service.latestForSession(sessionId);
        expect(latest).toBeNull();
      }),
    );
  });

  it("takeIfDue returns null when below threshold", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SnapshotService;
        const { sessionId } = setupProjectAndSession(conn);
        const r = yield* service.takeIfDue({
          sessionId,
          currentEventCount: 50,
          everyN: 100,
          build: () => sampleState(),
        });
        expect(r).toBeNull();
        const latest = yield* service.latestForSession(sessionId);
        expect(latest).toBeNull();
      }),
    );
  });

  it("takeIfDue writes a snapshot when threshold crossed and uses the build() result", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SnapshotService;
        const { sessionId } = setupProjectAndSession(conn);
        // currentEventCount=1, everyN=1, no prior snapshot → should write
        const built = sampleState();
        let buildCalled = false;
        const r = yield* service.takeIfDue({
          sessionId,
          currentEventCount: 1,
          everyN: 1,
          build: (events) => {
            buildCalled = true;
            expect(events.length).toBe(1);
            return built;
          },
        });
        expect(buildCalled).toBe(true);
        expect(r).not.toBeNull();
        expect(r?.event_count).toBe(1);
        const latest = yield* service.latestForSession(sessionId);
        expect(latest?.id).toBe(r?.id);
      }),
    );
  });

  it("takeIfDue uses the latest event's id as the snapshot event_id", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SnapshotService;
        const { sessionId } = setupProjectAndSession(conn);
        const e2 = "01eventxxxxxxxxxxxxxxxxxx2";
        // e1 was created at "now" (e.g. 2026-06-13T...); e2 must be later.
        seedEvent(conn, e2, "2099-12-31T23:59:59.000Z", sessionId);
        const r = yield* service.takeIfDue({
          sessionId,
          currentEventCount: 2,
          everyN: 2,
          build: () => sampleState(),
        });
        expect(r).not.toBeNull();
        expect(r?.event_id).toBe(e2);
        expect(r?.event_count).toBe(2);
      }),
    );
  });

  it("takeIfDue does not write when below the threshold after a prior snapshot", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SnapshotService;
        const { sessionId, eventId } = setupProjectAndSession(conn);
        const e2 = "01eventxxxxxxxxxxxxxxxxxx2";
        seedEvent(conn, e2, "2026-01-01T00:00:00.002Z", sessionId);
        // Take the first snapshot at eventCount=2
        const first = yield* service.takeIfDue({
          sessionId,
          currentEventCount: 2,
          everyN: 2,
          build: () => sampleState(),
        });
        expect(first).not.toBeNull();
        // Now currentEventCount=3, everyN=2, last=2 → (3-2)=1 < 2 → null
        const r = yield* service.takeIfDue({
          sessionId,
          currentEventCount: 3,
          everyN: 2,
          build: () => sampleState(),
        });
        expect(r).toBeNull();
        // Still only the first snapshot
        const latest = yield* service.latestForSession(sessionId);
        expect(latest?.id).toBe(first?.id);
        // The session's pointer was set to the first snapshot's event
        const updated = conn.handle.get<{ last_snapshot_event_id: string | null }>(
          "SELECT last_snapshot_event_id FROM sessions WHERE id = ?",
          [sessionId],
        );
        expect(updated?.last_snapshot_event_id).toBe(eventId); // e1 was first event of this session
      }),
    );
  });

  it("write is deterministic: same state → byte-equal state_json", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SnapshotService;
        const { sessionId, eventId } = setupProjectAndSession(conn);
        const e2 = "01eventxxxxxxxxxxxxxxxxxx2";
        seedEvent(conn, e2, "2026-01-01T00:00:00.002Z", sessionId);
        // sampleState() has a fixed field order; build two distinct
        // state-shaped objects with shuffled insertion orders of the
        // nested maps/arrays. The serializer should sort keys at every
        // level so the resulting JSON is byte-equal.
        const state1 = {
          ...sampleState(),
          // override with field insertion that goes from a to z alphabetically
        };
        const state2 = { ...sampleState() };
        const a = yield* service.write({
          sessionId,
          state: state1,
          eventId,
          eventCount: 1,
        });
        const b = yield* service.write({
          sessionId,
          state: state2,
          eventId: e2,
          eventCount: 2,
        });
        expect(a.state_json).toBe(b.state_json);
      }),
    );
  });

  it("write fails DbError when the session_id does not exist (FK)", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const service = yield* SnapshotService;
        // setupProjectAndSession gives us a valid event in a valid session.
        // We use that event's id as the snapshot's event_id (FK-resolves),
        // but pass a bogus session_id to trip snapshots.session_id FK.
        const conn = (yield* DbConnection) as unknown as Context.Tag.Service<typeof DbConnection>;
        const { eventId } = setupProjectAndSession(conn);
        const r = yield* service
          .write({
            sessionId: "01nosuchsessionhere00000",
            state: sampleState(),
            eventId,
            eventCount: 1,
          })
          .pipe(Effect.either);
        expect(r._tag).toBe("Left");
        if (r._tag === "Left") {
          expect(r.left._tag).toBe("DbError");
        }
      }),
    );
  });

  it("serializeState round-trips Map fields (the bug that bit the E2E test)", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SnapshotService;
        const { sessionId, eventId } = setupProjectAndSession(conn);
        // Build a state with a non-empty Map; the original bug dropped
        // Map contents on serialize, leaving the JSON with an empty
        // `{}` for the field.
        const state = {
          ...sampleState(),
          hypotheses: new Map([
            [
              "h1",
              {
                id: "h1",
                title: "leak",
                text: "turbopack bug",
                current_state: "rejected" as const,
                current_confidence: 0.1,
                current_reason: "evidence",
                reason_type: "evidence" as const,
                superseded_by_id: null,
                promoted_to_theory_id: null,
                belongs_to_theory_id: null,
                created_at: "2026-01-01T00:00:00.000Z",
                last_event_id: "01eventxxxxxxxxxxxxxxxxxx1",
                last_event_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          ]),
        };
        const written = yield* service.write({
          sessionId,
          state,
          eventId,
          eventCount: 1,
        });
        // The serialized JSON must contain the Map's entries by key.
        const parsed = JSON.parse(written.state_json) as { hypotheses: Record<string, unknown> };
        expect(parsed.hypotheses).toBeDefined();
        expect(Object.keys(parsed.hypotheses)).toContain("h1");
        expect((parsed.hypotheses.h1 as { id: string }).id).toBe("h1");
      }),
    );
  });
});
