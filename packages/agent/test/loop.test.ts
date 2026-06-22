/**
 * packages/agent/test/loop.test.ts — supervisor loop integration with mock LLM.
 *
 * Uses the real EventStore (in a temp SQLite db) + a mock LlmProvider.
 * This catches wiring bugs (wrong field name, missing yield, Effect
 * error channel mismatch) that unit tests on `applyDecision` /
 * `decodeAgentDecisionEither` cannot.
 *
 * Cases:
 *  1. happy path: empty session → mock returns "stop" decision → tick
 *     records 0 actions / 0 overrides and stop=true
 *  2. happy path: mock returns 2 actions + 1 rank override → 3 events
 *     appended, all visible via EventStore.list
 *  3. parse failure: mock returns non-JSON → tick fails with
 *     DecisionParseError, raw text attached, no events appended
 *  4. parse failure: mock returns valid JSON that fails AgentDecision
 *     validation (schema_version wrong) → tick fails
 *  5. idempotency: re-running with the same tickId is a no-op
 *     (idempotency check in EventStore.append returns existing rows)
 *  6. action cap: 7 actions emitted, max_actions_per_tick=3 → only
 *     first 3 are written; actionsTruncated = 4
 *  7. tickId auto-generated when omitted (still deterministic per-call
 *     by appearing in the appended event ids)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Context, Effect, Layer } from "effect";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { defaultConfig } from "@cognit/core/config";
import {
  DbConnection,
  EventStore,
  LoggerNoop,
  MigrationRegistryLive,
  RedactorLiveWithDefault,
  UuidTest,
  openDb,
} from "@cognit/db";
import { EventStoreDefault } from "@cognit/db";
import { resetUuidTestCounter } from "@cognit/db";
import {
  DecisionParseError,
  LlmProvider,
  applyDecision,
  defaultAgentConfig,
  llmProviderFrom,
  parseAgentConfig,
  runTick,
} from "../src/index.js";
import type { AgentDecision } from "../src/decision.js";

/**
 * Build a test layer with EventStore + Uuid + Redactor + Logger.
 * Mirrors the pattern from `@cognit/db/test/event-store.test.ts` so
 * the loop sees the same wiring production code does. We expose
 * UuidTest in the final output (not just inside the leafs used to
 * satisfy EventStore's R-channel) because the loop also pulls Uuid
 * from the R-channel for tick-id generation.
 */
const makeTestLayer = (dbPath: string) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(RedactorLiveWithDefault, MigrationRegistryLive, UuidTest, LoggerNoop);
  return Layer.merge(
    Layer.provide(Layer.provide(EventStoreDefault, leafs), dbConn),
    Layer.mergeAll(dbConn, LoggerNoop, UuidTest),
  );
};

const withTempDb = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-agent-"));
  return path.join(dir, "cognit.db");
};

const setupProjectAndSession = (conn: Context.Tag.Service<typeof DbConnection>): string => {
  const projectId = "01projectxxxxxxxxxxxxxxxxx";
  const sessionId = "01sessxxxxxxxxxxxxxxxxxxx";
  const now = new Date().toISOString();
  conn.handle.run(
    `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
    [projectId, "agent-test", now],
  );
  conn.handle.run(
    `INSERT INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    [sessionId, projectId, "tick test", "active", now],
  );
  // Pre-register the actor so ensureActor sees `isNew=false` and does
  // NOT emit an `actor_registered` audit row. That keeps the per-tick
  // event count == exactly the supervisor's own appends.
  conn.handle.run(
    `INSERT INTO actors (id, type, name, trust_score, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ["01alicexxxxxxxxxxxxxxxxxx", "human", "alice", 0.9, now, now],
  );
  return sessionId;
};

/**
 * Insert one or more hypothesis rows so events that FK-reference a
 * hypothesis (hypothesis_weakened / hypothesis_rejected / …
 * via `linked_hypothesis_id`) can be appended. Returns nothing.
 */
const seedHypotheses = (
  conn: Context.Tag.Service<typeof DbConnection>,
  sessionId: string,
  ids: ReadonlyArray<string>,
): void => {
  const now = new Date().toISOString();
  for (const id of ids) {
    conn.handle.run(
      `INSERT INTO hypotheses (id, session_id, title, text, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, sessionId, `title-${id}`, `text-${id}`, "active", now],
    );
  }
};

const ACTOR = { name: "alice", type: "human" as const };

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

describe("runTick — supervisor loop with mock LLM", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
    resetUuidTestCounter();
  });

  it("1. stop-only decision writes 0 events, stop=true", async () => {
    const llmLayer = llmProviderFrom(() =>
      Effect.succeed(
        JSON.stringify({
          schema_version: "1",
          rationale: "nothing to do",
          actions: [],
          rank_overrides: [],
          stop: true,
        } satisfies AgentDecision),
      ),
    );
    const out = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const sessionId = setupProjectAndSession(conn);
        return yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c2"),
          agent: defaultAgentConfig,
          actor: ACTOR,
        });
      }),
      dbPath,
      llmLayer,
    );
    expect(out.stop).toBe(true);
    expect(out.actionsApplied).toBe(0);
    expect(out.rankOverridesApplied).toBe(0);
  });

  it("2. 2 actions + 1 rank override → 3 events visible in EventStore.list", async () => {
    const llmLayer = llmProviderFrom(() =>
      Effect.succeed(
        JSON.stringify({
          schema_version: "1",
          rationale: "do things",
          actions: [
            { kind: "weaken_hypothesis", hypothesis_id: "H-1", reason: "lost support" },
            {
              kind: "request_verification",
              command: "vitest run",
              type: "test",
              linked_hypothesis_id: "H-2",
            },
          ],
          rank_overrides: [{ hypothesis_id: "H-3", score: 0.9, reasoning: "obvious" }],
          stop: false,
        } satisfies AgentDecision),
      ),
    );
    const out = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        seedHypotheses(conn, sessionId, ["H-1", "H-2", "H-3"]);
        const result = yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c2"),
          agent: defaultAgentConfig,
          actor: ACTOR,
        });
        const events = yield* store.list({ sessionId, limit: 1000 });
        return { result, events };
      }),
      dbPath,
      llmLayer,
    );
    expect(out.result.actionsApplied).toBe(2);
    expect(out.result.rankOverridesApplied).toBe(1);
    expect(out.result.stop).toBe(false);
    // Only the supervisor's appended rows: 2 actions + 1 rank = 3.
    expect(out.events.events.length).toBe(3);
    expect(out.events.events.map((e) => e.type).sort()).toEqual(
      ["hypothesis_ranked", "hypothesis_weakened", "verification_started"].sort(),
    );
  });

  it("3. parse failure: non-JSON raw → DecisionParseError, no events", async () => {
    const llmLayer = llmProviderFrom(() => Effect.succeed("not even json"));
    const result = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        const either = yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c2"),
          agent: defaultAgentConfig,
          actor: ACTOR,
        }).pipe(Effect.either);
        const events = yield* store.list({ sessionId, limit: 1000 });
        return { either, events };
      }),
      dbPath,
      llmLayer,
    );
    expect(result.either._tag).toBe("Left");
    if (result.either._tag === "Left") {
      expect(result.either.left).toBeInstanceOf(DecisionParseError);
      expect((result.either.left as DecisionParseError).raw).toBe("not even json");
    }
    expect(result.events.events.length).toBe(0);
  });

  it("4. parse failure: schema_version wrong → DecisionParseError", async () => {
    const llmLayer = llmProviderFrom(() =>
      Effect.succeed(
        JSON.stringify({
          schema_version: "999",
          rationale: "x",
          actions: [],
          stop: false,
        }),
      ),
    );
    const result = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const sessionId = setupProjectAndSession(conn);
        return yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c2"),
          agent: defaultAgentConfig,
          actor: ACTOR,
        }).pipe(Effect.either);
      }),
      dbPath,
      llmLayer,
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DecisionParseError);
    }
  });

  it("5. idempotency: same tickId applied twice writes nothing new", async () => {
    const llmLayer = llmProviderFrom(() =>
      Effect.succeed(
        JSON.stringify({
          schema_version: "1",
          rationale: "deterministic",
          actions: [{ kind: "weaken_hypothesis", hypothesis_id: "H-1", reason: "x" }],
          rank_overrides: [{ hypothesis_id: "H-1", score: 0.3, reasoning: "y" }],
          stop: false,
        } satisfies AgentDecision),
      ),
    );
    const out = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        seedHypotheses(conn, sessionId, ["H-1"]);
        const tickId = "01TICKIDxxxxxxxxxxxxxxxxxxx";
        yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c2"),
          agent: defaultAgentConfig,
          actor: ACTOR,
          tickId,
        });
        const afterFirst = yield* store.list({ sessionId, limit: 1000 });
        yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c2"),
          agent: defaultAgentConfig,
          actor: ACTOR,
          tickId,
        });
        const afterSecond = yield* store.list({ sessionId, limit: 1000 });
        return { countFirst: afterFirst.events.length, countSecond: afterSecond.events.length };
      }),
      dbPath,
      llmLayer,
    );
    expect(out.countFirst).toBe(2);
    expect(out.countSecond).toBe(2);
  });

  it("6. action cap: 7 actions, cap=3 → first 3 written, truncated=4", async () => {
    const actions = Array.from({ length: 7 }, (_, i) => ({
      kind: "weaken_hypothesis" as const,
      hypothesis_id: `H-${i + 1}`,
      reason: `r${i}`,
    }));
    const decision: AgentDecision = {
      schema_version: "1",
      rationale: "burst",
      actions,
      rank_overrides: [],
      stop: false,
    };
    const out = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        seedHypotheses(conn, sessionId, ["H-1", "H-2", "H-3", "H-4", "H-5", "H-6", "H-7"]);
        const applied = yield* applyDecision({
          store,
          decision,
          tickId: "01TICKxxxxxxxxxxxxxxxxxxxxx",
          sessionId,
          actor: ACTOR,
          cfg: parseAgentConfig({ max_actions_per_tick: 3 }),
        });
        const events = yield* store.list({ sessionId, limit: 1000 });
        return { applied, events };
      }),
      dbPath,
      llmProviderFrom(() => Effect.succeed("")),
    );
    expect(out.applied.actions.length).toBe(3);
    expect(out.applied.actionsTruncated).toBe(4);
    expect(out.events.events.length).toBe(3);
  });

  it("7. tickId omitted → caller-provided id flows through to event ids", async () => {
    const llmLayer = llmProviderFrom(() =>
      Effect.succeed(
        JSON.stringify({
          schema_version: "1",
          rationale: "auto id",
          actions: [{ kind: "weaken_hypothesis", hypothesis_id: "H-1", reason: "auto" }],
          rank_overrides: [],
          stop: false,
        } satisfies AgentDecision),
      ),
    );
    const out = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        seedHypotheses(conn, sessionId, ["H-1"]);
        const result = yield* runTick({
          sessionId,
          cfg: defaultConfig("agent-c2"),
          agent: defaultAgentConfig,
          actor: ACTOR,
        });
        const events = yield* store.list({ sessionId, limit: 1000 });
        return { result, events };
      }),
      dbPath,
      llmLayer,
    );
    expect(out.result.tickId.startsWith("01")).toBe(true);
    const inserted = out.events.events.find((e) => e.type === "hypothesis_weakened");
    expect(inserted?.id).toBe(`${out.result.tickId}-a0000`);
  });
});
