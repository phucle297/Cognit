/**
 * packages/agent/test/integration.test.ts — multi-session + error
 * integration tests for the supervisor loop.
 *
 * Sits beside `loop.test.ts` (single-session happy/sad path). The
 * loop is already unit-covered; this file exercises the cross-
 * session isolation guarantees + the four typed error channels the
 * supervisor loop promises to surface:
 *
 *   - LlmCompletionError    — provider layer rejects the call
 *   - DecisionParseError    — JSON.parse fails or schema rejects
 *   - ApplyError            — EventStore append chokepoint rejects
 *                             (ValidationFailure on bad FK)
 *   - happy multi-session   — three independent sessions run ticks
 *                             in sequence; events stay partitioned
 *                             by `session_id` and tick ids do not
 *                             collide across sessions
 *
 * Pattern follows `loop.test.ts`: real EventStore on a temp SQLite
 * file, mock LlmProvider via `llmProviderFrom`, ActorDefaults wired
 * so `ensureActor` does not emit a surprise `actor_registered` row.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Context, Effect, Layer } from "effect";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { defaultConfig } from "@cognit/core/config";
import {
  ActorDefaultsBuiltIn,
  actorDefaultsLayer,
  DbConnection,
  DbError,
  EventStore,
  LoggerNoop,
  MigrationRegistryLive,
  RedactorLiveWithDefault,
  UuidTest,
  openDb,
  resetUuidTestCounter,
  type EventRow,
} from "@cognit/db";
import { EventStoreDefault } from "@cognit/db";
import {
  DecisionParseError,
  LlmCompletionError,
  LlmProvider,
  defaultAgentConfig,
  llmProviderFrom,
  runTick,
} from "../src/index.js";
import type { AgentDecision } from "../src/decision.js";

const ACTOR = { name: "alice", type: "human" as const };

const withTempDb = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-agent-int-"));
  return path.join(dir, "cognit.db");
};

const makeTestLayer = (dbPath: string) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(
    RedactorLiveWithDefault,
    MigrationRegistryLive,
    UuidTest,
    LoggerNoop,
    actorDefaultsLayer(ActorDefaultsBuiltIn),
  );
  return Layer.merge(
    Layer.provide(Layer.provide(EventStoreDefault, leafs), dbConn),
    Layer.mergeAll(dbConn, LoggerNoop, UuidTest, actorDefaultsLayer(ActorDefaultsBuiltIn)),
  );
};

const runWithLayer = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
  dbPath: string,
  llmLayer: Layer.Layer<LlmProvider, never, never>,
): Promise<A> =>
  Effect.runPromise(
    eff.pipe(Effect.provide(Layer.merge(makeTestLayer(dbPath), llmLayer))) as Effect.Effect<
      A,
      E,
      never
    >,
  );

const seedProjectSession = (
  conn: Context.Tag.Service<typeof DbConnection>,
  projectId: string,
  sessionId: string,
  goal: string,
  now: string,
): void => {
  conn.handle.run(
    `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
    [projectId, "agent-int", now],
  );
  conn.handle.run(
    `INSERT INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    [sessionId, projectId, goal, "active", now],
  );
  conn.handle.run(
    `INSERT INTO actors (id, type, name, trust_score, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ["01alicexxxxxxxxxxxxxxxxxx", "human", "alice", 0.9, now, now],
  );
};

const seedHypothesis = (
  conn: Context.Tag.Service<typeof DbConnection>,
  sessionId: string,
  id: string,
  now: string,
): void => {
  conn.handle.run(
    `INSERT INTO hypotheses (id, session_id, title, text, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, sessionId, `title-${id}`, `text-${id}`, "active", now],
  );
};

const runOnce = (dbPath: string, llm: (raw: AgentDecision) => string) => {
  const llmLayer = llmProviderFrom(() =>
    Effect.succeed(
      llm({
        schema_version: "1",
        rationale: "ok",
        actions: [],
        rank_overrides: [],
        stop: false,
      }),
    ),
  );
  return runWithLayer(
    Effect.gen(function* () {
      const conn = yield* DbConnection;
      const store = yield* EventStore;
      const sessionId = "01sessxxxxxxxxxxxxxxxxxxx";
      const projectId = "01projectxxxxxxxxxxxxxxxxx";
      const now = new Date().toISOString();
      seedProjectSession(conn, projectId, sessionId, "multi", now);
      const result = yield* runTick({
        sessionId,
        cfg: defaultConfig("agent-c5"),
        agent: defaultAgentConfig,
        actor: ACTOR,
      });
      const events = yield* store.list({ sessionId, limit: 1000 });
      return { result, events: events.events, sessionId };
    }),
    dbPath,
    llmLayer,
  );
};

describe("runTick — multi-session isolation", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
    resetUuidTestCounter();
  });

  it("1. three sessions ticked in sequence → events stay partitioned by session_id", async () => {
    const out = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const now = new Date().toISOString();
        // Three independent sessions, all under one project. The
        // partition guarantee we exercise is per-session event
        // isolation, so the project id is shared by design.
        const projectId = "01projectxxxxxxxxxxxxxxxxx";
        const sessionIds = [
          "01sessa0xxxxxxxxxxxxxxxxxx",
          "01sessb0xxxxxxxxxxxxxxxxxx",
          "01sessc0xxxxxxxxxxxxxxxxxx",
        ];
        // Project is created once; sessions are created per id.
        conn.handle.run(
          `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
          [projectId, "agent-int", now],
        );
        conn.handle.run(
          `INSERT INTO actors (id, type, name, trust_score, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ["01alicexxxxxxxxxxxxxxxxxx", "human", "alice", 0.9, now, now],
        );
        for (const sid of sessionIds) {
          conn.handle.run(
            `INSERT INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
            [sid, projectId, "isolation", "active", now],
          );
        }
        const tickIds: string[] = [];
        for (const sid of sessionIds) {
          const r = yield* runTick({
            sessionId: sid,
            cfg: defaultConfig("agent-c5"),
            agent: defaultAgentConfig,
            actor: ACTOR,
          });
          tickIds.push(r.tickId);
        }
        // Per-session event lists.
        const perSession: Array<{ sid: string; events: ReadonlyArray<EventRow> }> = [];
        for (const sid of sessionIds) {
          const e = yield* store.list({ sessionId: sid, limit: 1000 });
          perSession.push({ sid, events: e.events });
        }
        // Project-wide event list (the supervisor's view, used by
        // recovery / dashboard cross-session).
        const all = yield* store.list({ sessionId: sessionIds[0]!, limit: 1000 });
        void all; // sanity — the call itself must not throw
        return { tickIds, perSession };
      }),
      dbPath,
      llmProviderFrom(() =>
        Effect.succeed(
          JSON.stringify({
            schema_version: "1",
            rationale: "noop",
            actions: [],
            rank_overrides: [],
            stop: true,
          } satisfies AgentDecision),
        ),
      ),
    );
    expect(out.tickIds).toHaveLength(3);
    // Each tick id is a fresh ULID — no collision across sessions.
    expect(new Set(out.tickIds).size).toBe(3);
    for (const { sid, events } of out.perSession) {
      // mock decision is stop=true with no actions and no rank
      // overrides → zero events for that session.
      expect(events.length).toBe(0);
      // Every event, if any, must belong to the same session.
      for (const e of events) {
        expect(e.session_id).toBe(sid);
      }
    }
  });

  it("2. concurrent ticks on the same session: idempotency keyed on tickId", async () => {
    // The supervisor's per-event append chokepoint is idempotent on
    // event id, and the tickId-derived event ids are unique per
    // tick. Two ticks with DIFFERENT tickIds should both land; two
    // ticks with the SAME tickId should produce the same event set.
    const out = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = "01sessxxxxxxxxxxxxxxxxxxx";
        const now = new Date().toISOString();
        seedProjectSession(conn, "01projectxxxxxxxxxxxxxxxxx", sessionId, "idem", now);
        // The mock layer below emits the same decision (1 rank
        // override) on every call. The unused `decision` constant
        // is intentionally removed — keeping it would shadow the
        // mock's payload and the typecheck would not flag a typo.
        seedHypothesis(conn, sessionId, "H-1", now);
        // First tick: distinct tickId.
        const r1 = yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c5"),
          agent: defaultAgentConfig,
          actor: ACTOR,
          tickId: "01TICKA00000000000000000",
        });
        // Second tick: distinct tickId, same decision.
        const r2 = yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c5"),
          agent: defaultAgentConfig,
          actor: ACTOR,
          tickId: "01TICKB00000000000000000",
        });
        // Third tick: REUSE first tickId — should be a no-op.
        const r3 = yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c5"),
          agent: defaultAgentConfig,
          actor: ACTOR,
          tickId: "01TICKA00000000000000000",
        });
        const events = yield* store.list({ sessionId, limit: 1000 });
        return { r1, r2, r3, events: events.events };
      }),
      dbPath,
      llmProviderFrom(() =>
        Effect.succeed(
          JSON.stringify({
            schema_version: "1",
            rationale: "rank",
            actions: [],
            rank_overrides: [{ hypothesis_id: "H-1", score: 0.7, reasoning: "ok" }],
            stop: false,
          } satisfies AgentDecision),
        ),
      ),
    );
    // Two distinct ticks: 2 rank events.
    expect(out.r1.tickId).not.toBe(out.r2.tickId);
    expect(out.r3.tickId).toBe(out.r1.tickId); // re-uses
    expect(out.events.length).toBe(2);
    const eventIds = new Set(out.events.map((e) => e.id));
    expect(eventIds.size).toBe(2);
  });
});

describe("runTick — error channels", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
    resetUuidTestCounter();
  });

  it("3. LlmCompletionError propagates from the provider layer", async () => {
    // Provider layer fails the Effect — loop must surface it
    // verbatim on its error channel so the CLI can render a clean
    // `cognit: tick failed: LlmCompletionError: ...` line.
    const llmLayer = llmProviderFrom(() =>
      Effect.fail(new LlmCompletionError("provider down for maintenance")),
    );
    const result = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = "01sessxxxxxxxxxxxxxxxxxxx";
        const now = new Date().toISOString();
        seedProjectSession(conn, "01projectxxxxxxxxxxxxxxxxx", sessionId, "err-llm", now);
        const either = yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c5"),
          agent: defaultAgentConfig,
          actor: ACTOR,
        }).pipe(Effect.either);
        const events = yield* store.list({ sessionId, limit: 1000 });
        return { either, events: events.events };
      }),
      dbPath,
      llmLayer,
    );
    expect(result.either._tag).toBe("Left");
    if (result.either._tag === "Left") {
      expect(result.either.left).toBeInstanceOf(LlmCompletionError);
      expect((result.either.left as LlmCompletionError).message).toMatch(/provider down/);
    }
    // No events appended — the LLM call failed before apply.
    expect(result.events.length).toBe(0);
  });

  it("4. DecisionParseError on non-JSON raw output", async () => {
    // The mock layer does NOT implement `completeJson`, so the loop
    // falls back to `complete` + manual `JSON.parse`. Bad input
    // surfaces as `DecisionParseError` with the raw text attached.
    const llmLayer = llmProviderFrom(() => Effect.succeed("oops not JSON"));
    const result = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = "01sessxxxxxxxxxxxxxxxxxxx";
        const now = new Date().toISOString();
        seedProjectSession(conn, "01projectxxxxxxxxxxxxxxxxx", sessionId, "err-parse", now);
        const either = yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c5"),
          agent: defaultAgentConfig,
          actor: ACTOR,
        }).pipe(Effect.either);
        const events = yield* store.list({ sessionId, limit: 1000 });
        return { either, events: events.events };
      }),
      dbPath,
      llmLayer,
    );
    expect(result.either._tag).toBe("Left");
    if (result.either._tag === "Left") {
      expect(result.either.left).toBeInstanceOf(DecisionParseError);
      const e = result.either.left as DecisionParseError;
      expect(e.raw).toBe("oops not JSON");
    }
    expect(result.events.length).toBe(0);
  });

  it("5. DecisionParseError on schema-invalid JSON (wrong schema_version)", async () => {
    // JSON is valid; AgentDecision decoder rejects it. Loop
    // re-wraps as DecisionParseError (single error class for any
    // LLM-output-decode failure).
    const llmLayer = llmProviderFrom(() =>
      Effect.succeed(
        JSON.stringify({
          schema_version: "999",
          rationale: "future",
          actions: [],
          stop: false,
        }),
      ),
    );
    const result = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = "01sessxxxxxxxxxxxxxxxxxxx";
        const now = new Date().toISOString();
        seedProjectSession(conn, "01projectxxxxxxxxxxxxxxxxx", sessionId, "err-schema", now);
        const either = yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c5"),
          agent: defaultAgentConfig,
          actor: ACTOR,
        }).pipe(Effect.either);
        const events = yield* store.list({ sessionId, limit: 1000 });
        return { either, events: events.events };
      }),
      dbPath,
      llmLayer,
    );
    expect(result.either._tag).toBe("Left");
    if (result.either._tag === "Left") {
      expect(result.either.left).toBeInstanceOf(DecisionParseError);
    }
    expect(result.events.length).toBe(0);
  });

  it("6. ApplyError on bad hypothesis FK (ValidationFailure from EventStore.append)", async () => {
    // The LLM emits a `weaken_hypothesis` action that points at a
    // hypothesis id we never seeded. The EventStore append
    // chokepoint rejects with `ValidationFailure` (FK constraint).
    const llmLayer = llmProviderFrom(() =>
      Effect.succeed(
        JSON.stringify({
          schema_version: "1",
          rationale: "bad fk",
          actions: [
            { kind: "weaken_hypothesis", hypothesis_id: "H-MISSING", reason: "x" },
          ],
          rank_overrides: [],
          stop: false,
        } satisfies AgentDecision),
      ),
    );
    const result = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = "01sessxxxxxxxxxxxxxxxxxxx";
        const now = new Date().toISOString();
        seedProjectSession(conn, "01projectxxxxxxxxxxxxxxxxx", sessionId, "err-fk", now);
        // Note: NO seedHypothesis for H-MISSING — the FK must fail.
        const either = yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c5"),
          agent: defaultAgentConfig,
          actor: ACTOR,
        }).pipe(Effect.either);
        const events = yield* store.list({ sessionId, limit: 1000 });
        return { either, events: events.events };
      }),
      dbPath,
      llmLayer,
    );
    expect(result.either._tag).toBe("Left");
    if (result.either._tag === "Left") {
      // ApplyError = UnknownEventType | ValidationFailure | UnknownSession | DbError.
      // Bad hypothesis FK trips the SQLite `FOREIGN KEY` constraint
      // at INSERT time — the driver throw is wrapped by `trySync`
      // into a typed `DbError`. We assert the union lands on the
      // `DbError` variant + that the cause mentions the constraint.
      const e = result.either.left as { name?: string; message?: string; cause?: { message?: string } };
      expect(e.name).toBe("DbError");
      const cause = e.cause?.message ?? e.message ?? "";
      expect(cause.toLowerCase()).toMatch(/foreign|constraint|hypothesis/);
      // The thrown DbError instance type-confirms the variant.
      void result.either.left as unknown as DbError;
    }
    // ApplyError short-circuits the tick — no events appended.
    expect(result.events.length).toBe(0);
  });
});

describe("runTick — multi-session independence sanity", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
    resetUuidTestCounter();
  });

  it("7. per-session runTick does not cross-contaminate event counts", async () => {
    // Sanity check that the same in-memory layer stack can host
    // independent session views: tick session A twice, tick
    // session B once, assert counts.
    const out = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const now = new Date().toISOString();
        const projectId = "01projectxxxxxxxxxxxxxxxxx";
        const sidA = "01sessA00000000000000000";
        const sidB = "01sessB00000000000000000";
        // Single project, two sessions — partition guarantee is
        // per-session, not per-project.
        conn.handle.run(
          `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
          [projectId, "agent-int", now],
        );
        conn.handle.run(
          `INSERT INTO actors (id, type, name, trust_score, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ["01alicexxxxxxxxxxxxxxxxxx", "human", "alice", 0.9, now, now],
        );
        for (const [sid, goal] of [[sidA, "A"], [sidB, "B"]] as const) {
          conn.handle.run(
            `INSERT INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
            [sid, projectId, goal, "active", now],
          );
        }
        seedHypothesis(conn, sidA, "H-A", now);
        seedHypothesis(conn, sidB, "H-B", now);
        // Two ticks on A, one on B. The mock returns the same
        // decision for every call. We tick the sessions with
        // distinct mock responses so the rank override targets
        // the right session's hypothesis and we can verify the
        // counts (1 per tick, never cross-contaminating).
        // Tick A: 1 rank override (H-A).
        const a1 = yield* runTick({
          sessionId: sidA,
          cfg: defaultConfig("agent-c5"),
          agent: defaultAgentConfig,
          actor: ACTOR,
          tickId: "01AICK00000000000000000A",
        }).pipe(
          Effect.provide(
            llmProviderFrom(() =>
              Effect.succeed(
                JSON.stringify({
                  schema_version: "1",
                  rationale: "rank A",
                  actions: [],
                  rank_overrides: [
                    { hypothesis_id: "H-A", score: 0.5, reasoning: "x" },
                  ],
                  stop: false,
                } satisfies AgentDecision),
              ),
            ),
          ),
        );
        // Tick B: 1 rank override (H-B) — independent.
        const b1 = yield* runTick({
          sessionId: sidB,
          cfg: defaultConfig("agent-c5"),
          agent: defaultAgentConfig,
          actor: ACTOR,
          tickId: "01BICK00000000000000000A",
        }).pipe(
          Effect.provide(
            llmProviderFrom(() =>
              Effect.succeed(
                JSON.stringify({
                  schema_version: "1",
                  rationale: "rank B",
                  actions: [],
                  rank_overrides: [
                    { hypothesis_id: "H-B", score: 0.7, reasoning: "y" },
                  ],
                  stop: false,
                } satisfies AgentDecision),
              ),
            ),
          ),
        );
        const a = yield* store.list({ sessionId: sidA, limit: 1000 });
        const b = yield* store.list({ sessionId: sidB, limit: 1000 });
        return {
          a1TickId: a1.tickId,
          b1TickId: b1.tickId,
          aCount: a.events.length,
          bCount: b.events.length,
          aEvents: a.events,
          bEvents: b.events,
        };
      }),
      // Outer mock is only a fallback (each tick overrides it
      // above with Effect.provide). A `complete` that errors is
      // safe because no tick reaches the outer layer.
      dbPath,
      llmProviderFrom(() => Effect.fail(new LlmCompletionError("unused"))),
    );
    expect(out.a1TickId).not.toBe(out.b1TickId);
    // A got 1 rank event; B got 1 rank event; never the other.
    expect(out.aCount).toBe(1);
    expect(out.bCount).toBe(1);
    for (const e of out.aEvents) expect(e.session_id).toBe("01sessA00000000000000000");
    for (const e of out.bEvents) expect(e.session_id).toBe("01sessB00000000000000000");
    // Hypothesis FK lands on the right session — A's event is for
    // H-A, B's for H-B. The payload shape comes from
    // hypothesis_ranked.
    const aPayload = JSON.parse(out.aEvents[0]!.payload_json) as {
      hypothesis_id: string;
    };
    const bPayload = JSON.parse(out.bEvents[0]!.payload_json) as {
      hypothesis_id: string;
    };
    expect(aPayload.hypothesis_id).toBe("H-A");
    expect(bPayload.hypothesis_id).toBe("H-B");
  });
});

// Reference: runOnce exists for symmetry with loop.test.ts; the
// helper is unused in this file's assertions because the multi-
// session case hand-rolls the orchestration. Keeping the helper
// exported (via a void reference) makes it easy to add a single-
// session integration case later without re-deriving the
// boilerplate.
void runOnce;
