/**
 * Phase 3c — P0 constraint audit emission (Cognit-5vl.9).
 *
 * The chokepoint in `SessionService.appendEvent` calls `evalRules`
 * before delegating to `EventStore.append`. Plan acceptance
 * criterion #3 (plans/phase-3.md) requires:
 *
 *   "non-violating events that match a non-blocking rule produce a
 *    `constraint_rule_applied` event in the same tx."
 *
 * v1 actions are closed at "block" (see
 * `@cognit/core/constraint-dsl.ts:172-177`), so the engine's typed
 * `then` is `{ readonly kind: "block" }`. The audit emission code
 * path is therefore dormant in production but must be wired and
 * tested. These tests cover the three branches:
 *
 *   A) a non-block rule matches  -> main event + audit event in tx
 *   B) a block rule matches     -> ConstraintViolation, no audit
 *   C) no rule matches          -> main event, no audit
 *
 * The test layer overrides `ConstraintPolicy` with a fixture
 * implementation that returns a hand-built `EngineRule`. We cast
 * the `then` field to bypass the closed v1 union (the runtime check
 * is `=== "block"`, so a non-block action falls through to the
 * audit path).
 */

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
  RedactorLive,
  SessionPolicy,
  SessionService,
  SessionServiceLive,
  SnapshotService,
  SnapshotServiceLive,
  UuidTest,
} from "../src";
import { EventStoreLive } from "../src/event-store";
import {
  ConstraintPolicy,
  type ConstraintPolicyShape,
} from "../src/constraint-policy";
import { compileRule, type EngineRule } from "../src/constraint-engine";

const ACTOR = { name: "alice", type: "human" as const };

const withTempDb = (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), "cognit-audit-")).then((dir) =>
    path.join(dir, "cognit.db"),
  );

const setupProject = (conn: Context.Tag.Service<typeof DbConnection>): string => {
  const projectId = "01projectxxxxxxxxxxxxxxxxx";
  conn.handle.run(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`, [
    projectId,
    "test-project",
    new Date().toISOString(),
  ]);
  return projectId;
};

/**
 * Build a test layer that injects a hand-crafted `ConstraintPolicy`
 * returning a fixed rule set. The default `ConstraintPolicyLive`
 * always re-parses wire-form events into block-only rules; this
 * fixture lets us inject non-block actions to exercise the audit
 * path.
 */
const makeAuditLayer = (
  dbPath: string,
  rules: ReadonlyArray<EngineRule>,
): Layer.Layer<
  | EventStore
  | DbConnection
  | SessionService
  | SnapshotService
  | Logger
  | ConstraintPolicy,
  never,
  never
> => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(RedactorLive, MigrationRegistryLive, UuidTest, LoggerNoop);
  const eventStore = Layer.provide(Layer.provide(EventStoreLive, leafs), dbConn);
  const snapshotService = Layer.provide(SnapshotServiceLive, Layer.merge(leafs, dbConn));
  // Inject the fixture policy in place of ConstraintPolicyLive.
  // `Layer.succeed` requires a Context.Tag — pass the resolved
  // service shape so the chokepoint can call `loadRules`.
  const fixturePolicy: ConstraintPolicyShape = {
    loadRules: (_sessionId: string) => Effect.succeed(rules),
  };
  const policyLayer: Layer.Layer<ConstraintPolicy> = Layer.succeed(ConstraintPolicy)(
    fixturePolicy,
  );
  // SessionPolicy is required by SessionServiceLive. The default
  // (everyN: 100) is fine for the audit tests — none of them push
  // the event count anywhere near the auto-snapshot threshold.
  const sessionPolicyLayer: Layer.Layer<SessionPolicy> = Layer.succeed(SessionPolicy)({
    everyN: 100,
    forkOnResume: true,
  });
  // sessionService needs EventStore + SnapshotService + ConstraintPolicy
  // + leafs + DbConnection + SessionPolicy. Same wiring shape as the
  // existing test, but the ConstraintPolicy slot is the fixture
  // rather than ConstraintPolicyLive.
  const sessionService = Layer.provide(
    Layer.provide(
      Layer.provide(SessionServiceLive, sessionPolicyLayer),
      policyLayer,
    ),
    Layer.merge(
      Layer.merge(Layer.merge(eventStore, snapshotService), dbConn),
      leafs,
    ),
  );
  return Layer.merge(
    Layer.merge(
      Layer.merge(Layer.merge(eventStore, sessionService), snapshotService),
      policyLayer,
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

const runWithLayer = <E, R>(
  layer: Layer.Layer<any, never, never>,
  eff: Effect.Effect<any, E, R>,
): Promise<any> =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<any, E, never>);

describe("Constraint chokepoint — audit emission (phase 3c, Cognit-5vl.9)", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  it("A: emits constraint_rule_applied when a non-block rule matches", async () => {
    // Rule with then: { kind: "tag" } — bypasses the v1 type union
    // via `as unknown as EngineRule`. The engine's runtime check
    // (`r.then.kind === "block"`) is false, so the rule is added to
    // `matchedRuleIds` without blocking.
    const rule = {
      rule_id: "audit-rule-1",
      when: { kind: "event.type", equals: "observation_recorded" },
      then: { kind: "tag" },
      reason: "tag-only rule",
    } as unknown as EngineRule;
    // Confirm the rule is non-block at runtime.
    expect((rule as { then: { kind: string } }).then.kind).not.toBe("block");

    const layer = makeAuditLayer(dbPath, [rule]);
    await runWithLayer(
      layer,
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const store = yield* EventStore;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "audit A",
          actor: ACTOR,
        });
        const sessionId = created.session.id;

        // The chokepoint should allow the event (non-block rule)
        // and write a `constraint_rule_applied` audit row in the
        // same tx.
        const r = yield* service.appendEvent({
          sessionId,
          type: "observation_recorded",
          payload: { text: "audit me" },
          actor: ACTOR,
        });
        expect(r.event.type).toBe("observation_recorded");

        // The audit event must be in the log alongside the main
        // event, sharing the same session and actor.
        const auditList = yield* store.list({
          sessionId,
          type: "constraint_rule_applied",
        });
        expect(auditList.events).toHaveLength(1);
        const auditRow = auditList.events[0]!;
        const payload = JSON.parse(auditRow.payload_json) as {
          rule_id: string;
          affected_hypothesis_ids: string[];
        };
        expect(payload.rule_id).toBe("audit-rule-1");
        expect(payload.affected_hypothesis_ids).toEqual([]);
        // The audit event's actor matches the main event's actor.
        expect(auditRow.actor_id).toBe(r.event.actor_id);
        // The audit event sorts at the same instant as the main
        // event (atomic in the same tx).
        expect(auditRow.created_at).toBe(r.event.created_at);
        // The audit event is caused by the main event.
        expect(auditRow.causation_id).toBe(r.event.id);
      }),
    );
  });

  it("B: emits NO audit when a block rule matches and append fails", async () => {
    const rule: EngineRule = compileRule(
      {
        rule_id: "block-obs",
        when: { kind: "event.type", equals: "observation_recorded" },
        then: { kind: "block" } as never,
        reason: "block observations",
      },
      "block-obs",
    );

    const layer = makeAuditLayer(dbPath, [rule]);
    await runWithLayer(
      layer,
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const store = yield* EventStore;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "audit B",
          actor: ACTOR,
        });
        const sessionId = created.session.id;

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
        }

        // The main event must NOT be on the log (chokepoint rejected
        // it before delegating to the store) and likewise the audit
        // event must NOT be on the log.
        const all = yield* store.list({ sessionId });
        const types = all.events.map((e) => e.type);
        expect(types).not.toContain("observation_recorded");
        expect(types).not.toContain("constraint_rule_applied");
      }),
    );
  });

  it("C: emits NO audit when no rule matches", async () => {
    // A rule that does not match the candidate event type. The
    // engine returns `allow: true` and `matchedRuleIds: []`, so the
    // chokepoint must NOT pass `constraintMatchedRuleIds`.
    const rule: EngineRule = {
      rule_id: "unrelated",
      when: { kind: "event.type", equals: "hypothesis_promoted" },
      then: { kind: "block" },
      reason: "would block promotions",
    };

    const layer = makeAuditLayer(dbPath, [rule]);
    await runWithLayer(
      layer,
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const service = yield* SessionService;
        const store = yield* EventStore;
        const projectId = setupProject(conn);
        const created = yield* service.create({
          projectId,
          goal: "audit C",
          actor: ACTOR,
        });
        const sessionId = created.session.id;

        const r = yield* service.appendEvent({
          sessionId,
          type: "observation_recorded",
          payload: { text: "fine" },
          actor: ACTOR,
        });
        expect(r.event.type).toBe("observation_recorded");

        const auditList = yield* store.list({
          sessionId,
          type: "constraint_rule_applied",
        });
        expect(auditList.events).toHaveLength(0);
      }),
    );
  });
});

// Reference ConstraintPolicyShape so it stays in the import set
// (TypeScript type-only — keeps the export from being tree-shaken
// if a future refactor needs it).
const _policyShape: ConstraintPolicyShape | undefined = undefined;
void _policyShape;
