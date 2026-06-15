import { describe, expect, it } from "vitest";
import { Context, Effect, Layer } from "effect";
import { CognitionService, CognitionServiceLive, SessionService } from "../src";

/**
 * Test the CognitionService shell in isolation: every method must
 * call `SessionService.appendEvent` (or, for reads like `listEdges`,
 * `SessionService.show`) with the right typed payload and the right
 * session/actor cross-cutting fields.
 *
 * We mock `SessionService` with a Layer that captures inputs and
 * returns synthetic rows. No SQLite, no real services — the goal is
 * to validate the shell, not the chokepoint.
 */
describe("CognitionService", () => {
  type AppendEventInput = Parameters<
    Context.Tag.Service<typeof SessionService>["appendEvent"]
  >[0];
  type SessionAppendEventResult = ReturnType<
    Context.Tag.Service<typeof SessionService>["appendEvent"]
  > extends Effect.Effect<infer R, infer _E, infer _R>
    ? R
    : never;

  const SESSION_ID = "01SESS00000000000000000000";
  const EVENT_ID = "01EVT0000000000000000000000";
  const THEORY_ID = "01THR00000000000000000000";
  const HYP_ID = "01HYP00000000000000000000";
  const EXPERIMENT_ID = "01EXP00000000000000000000";
  const DECISION_ID = "01DEC00000000000000000000";
  const CONCLUSION_ID = "01CON00000000000000000000";
  const VERIFICATION_ID = "01VER00000000000000000000";
  const ARTIFACT_ID = "01ART00000000000000000000";

  type Captured = {
    inputs: AppendEventInput[];
    count: number;
    edges: ReadonlyArray<{
      readonly id: string;
      readonly edge_type: string;
      readonly from_entity_type: string;
      readonly from_entity_id: string;
      readonly to_entity_type: string;
      readonly to_entity_id: string;
      readonly created_at: string;
    }>;
  };

  const makeMockSessionsLayer = (captured: Captured): Layer.Layer<SessionService> => {
    const layer = Layer.succeed(SessionService)({
      create: () => Effect.die("not used in this test") as never,
      list: () => Effect.die("not used in this test") as never,
      getByGoalOrId: () => Effect.die("not used in this test") as never,
      pause: () => Effect.die("not used in this test") as never,
      close: () => Effect.die("not used in this test") as never,
      resume: () => Effect.die("not used in this test") as never,
      show: (sessionId) =>
        Effect.succeed({
          session: {
            id: sessionId,
            project_id: "01PROJ00000000000000000000",
            goal: "test",
            status: "open",
            parent_session_id: null,
            depth: 0,
            created_at: "2026-06-15T00:00:00.000Z",
            updated_at: "2026-06-15T00:00:00.000Z",
            closed_at: null,
          },
          state: {
            session_id: sessionId,
            goal: "test",
            status: "open",
            observations: [],
            findings: [],
            hypotheses: [],
            theories: [],
            experiments: [],
            decisions: [],
            conclusions: [],
            verifications: [],
            artifacts: [],
            edges: captured.edges,
            redaction_count: 0,
            updated_at: "2026-06-15T00:00:00.000Z",
          } as never,
          snapshot: null,
          eventsAfterSnapshot: 0,
        } as never),
      takeSnapshot: () => Effect.die("not used in this test") as never,
      appendEvent: (input) => {
        captured.inputs.push(input);
        captured.count += 1;
        return Effect.succeed({
          event: {
            id: EVENT_ID,
            project_id: "01PROJ00000000000000000000",
            session_id: input.sessionId,
            actor_id: "01ACT0000000000000000000000",
            type: input.type,
            version: "1.0.0",
            payload_json: JSON.stringify(input.payload),
            source_json: null,
            artifact_refs_json: null,
            causation_id: null,
            correlation_id: null,
            confidence: input.confidence ?? null,
            parent_verification_id: null,
            linked_hypothesis_id: input.linkedHypothesisId ?? null,
            created_at: "2026-06-15T00:00:00.000Z",
          },
          snapshotTaken: false,
        } as SessionAppendEventResult);
      },
    });
    return layer;
  };

  // ===========================================================================
  // 3a-1: observation
  // ===========================================================================
  it("recordObservation calls SessionService.appendEvent with the typed observation payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.recordObservation({
          sessionId: SESSION_ID,
          text: "got NPE in UserService",
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        { id: string; type: string; session_id: string; created_at: string },
        unknown,
        never
      >,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("observation_recorded");
    expect(input?.sessionId).toBe(SESSION_ID);
    expect(input?.payload).toEqual({ text: "got NPE in UserService" });
    expect(input?.actor).toEqual({ name: "alice", type: "human" });
    expect(input?.confidence).toBeUndefined();
    expect(input?.linkedHypothesisId).toBeUndefined();
    expect(result.id).toBe(EVENT_ID);
    expect(result.type).toBe("observation_recorded");
  });

  // ===========================================================================
  // 3a-2: finding
  // ===========================================================================
  it("recordFinding calls SessionService.appendEvent with the typed finding payload and related_observation_ids", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.recordFinding({
          sessionId: SESSION_ID,
          text: "NPE is caused by uninitialised session token",
          relatedObservationIds: ["OBS001", "OBS002"],
          actor: { name: "alice", type: "human" },
          confidence: 0.8,
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        { id: string; type: string; session_id: string; created_at: string },
        unknown,
        never
      >,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("finding_created");
    expect(input?.sessionId).toBe(SESSION_ID);
    expect(input?.payload).toEqual({
      text: "NPE is caused by uninitialised session token",
      related_observation_ids: ["OBS001", "OBS002"],
    });
    expect(input?.actor).toEqual({ name: "alice", type: "human" });
    expect(input?.confidence).toBe(0.8);
    expect(input?.linkedHypothesisId).toBeUndefined();
    expect(result.id).toBe(EVENT_ID);
    expect(result.type).toBe("finding_created");
  });

  it("recordFinding defaults related_observation_ids to an empty array when omitted", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.recordFinding({
          sessionId: SESSION_ID,
          text: "naked finding, no related observations",
          actor: { name: "bot", type: "worker" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        { id: string; type: string; session_id: string; created_at: string },
        unknown,
        never
      >,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("finding_created");
    expect(input?.payload).toEqual({
      text: "naked finding, no related observations",
      related_observation_ids: [],
    });
    expect(input?.confidence).toBeUndefined();
  });

  // ===========================================================================
  // 3a-3: hypothesis
  // ===========================================================================
  it("proposeHypothesis calls SessionService.appendEvent with the typed hypothesis_created payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.proposeHypothesis({
          sessionId: SESSION_ID,
          title: "NPE root cause",
          text: "we believe the UserService hits a null pointer when the session cache is empty",
          actor: { name: "alice", type: "human" },
          confidence: 0.7,
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        { id: string; type: string; session_id: string; created_at: string },
        unknown,
        never
      >,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("hypothesis_created");
    expect(input?.sessionId).toBe(SESSION_ID);
    expect(input?.payload).toEqual({
      title: "NPE root cause",
      text: "we believe the UserService hits a null pointer when the session cache is empty",
    });
    expect(input?.actor).toEqual({ name: "alice", type: "human" });
    expect(input?.confidence).toBe(0.7);
    expect(input?.linkedHypothesisId).toBeUndefined();
    expect(result.type).toBe("hypothesis_created");
  });

  it("weakenHypothesis calls SessionService.appendEvent with the typed hypothesis_weakened payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.weakenHypothesis({
          sessionId: SESSION_ID,
          hypothesisId: HYP_ID,
          reason: "replicated only on 2 of 5 staging boxes",
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        { id: string; type: string; session_id: string; created_at: string },
        unknown,
        never
      >,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("hypothesis_weakened");
    expect(input?.sessionId).toBe(SESSION_ID);
    expect(input?.payload).toEqual({ reason: "replicated only on 2 of 5 staging boxes" });
    expect(input?.linkedHypothesisId).toBe(HYP_ID);
    expect(input?.confidence).toBeUndefined();
    expect(result.type).toBe("hypothesis_weakened");
  });

  it("rejectHypothesis calls SessionService.appendEvent with the typed hypothesis_rejected payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);
    const NEW_HYP_ID = "01HYP00000000000000000099";

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.rejectHypothesis({
          sessionId: SESSION_ID,
          hypothesisId: HYP_ID,
          reasonType: "superseded",
          supersededById: NEW_HYP_ID,
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        { id: string; type: string; session_id: string; created_at: string },
        unknown,
        never
      >,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("hypothesis_rejected");
    expect(input?.payload).toEqual({
      reason_type: "superseded",
      superseded_by_id: NEW_HYP_ID,
    });
    expect(input?.linkedHypothesisId).toBe(HYP_ID);
    expect(result.type).toBe("hypothesis_rejected");
  });

  it("rejectHypothesis without supersededById sets superseded_by_id to null", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.rejectHypothesis({
          sessionId: SESSION_ID,
          hypothesisId: HYP_ID,
          reasonType: "evidence",
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        { id: string; type: string; session_id: string; created_at: string },
        unknown,
        never
      >,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("hypothesis_rejected");
    expect(input?.payload).toEqual({
      reason_type: "evidence",
      superseded_by_id: null,
    });
  });

  it("promoteHypothesis calls SessionService.appendEvent with the typed hypothesis_promoted payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.promoteHypothesis({
          sessionId: SESSION_ID,
          hypothesisId: HYP_ID,
          promotedToTheoryId: THEORY_ID,
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        { id: string; type: string; session_id: string; created_at: string },
        unknown,
        never
      >,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("hypothesis_promoted");
    expect(input?.payload).toEqual({ promoted_to_theory_id: THEORY_ID });
    expect(input?.linkedHypothesisId).toBe(HYP_ID);
    expect(result.type).toBe("hypothesis_promoted");
  });

  // ===========================================================================
  // 3a-4: theory
  // ===========================================================================
  it("addTheory calls SessionService.appendEvent with the typed theory_created payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.addTheory({
          sessionId: SESSION_ID,
          title: "Caching explains the NPE pattern",
          text: "All observed NPEs share a missing cache-warm step.",
          actor: { name: "alice", type: "human" },
          confidence: 0.6,
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        { id: string; type: string; session_id: string; created_at: string },
        unknown,
        never
      >,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("theory_created");
    expect(input?.payload).toEqual({
      title: "Caching explains the NPE pattern",
      text: "All observed NPEs share a missing cache-warm step.",
    });
    expect(input?.confidence).toBe(0.6);
    expect(result.type).toBe("theory_created");
  });

  it("updateTheory calls SessionService.appendEvent with the typed theory_updated payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.updateTheory({
          sessionId: SESSION_ID,
          theoryId: THEORY_ID,
          text: "All observed NPEs share a missing cache-warm step. Edited.",
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("theory_updated");
    expect(input?.payload).toEqual({
      text: "All observed NPEs share a missing cache-warm step. Edited.",
    });
  });

  it("mergeTheory calls SessionService.appendEvent with the typed theory_merged payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.mergeTheory({
          sessionId: SESSION_ID,
          theoryId: THEORY_ID,
          mergedIntoTheoryId: "01THR00000000000000000099",
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("theory_merged");
    expect(input?.payload).toEqual({ merged_into_theory_id: "01THR00000000000000000099" });
  });

  it("archiveTheory calls SessionService.appendEvent with the empty theory_archived payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.archiveTheory({
          sessionId: SESSION_ID,
          theoryId: THEORY_ID,
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("theory_archived");
    expect(input?.payload).toEqual({});
  });

  // ===========================================================================
  // 3a-4: experiment
  // ===========================================================================
  it("addExperiment calls SessionService.appendEvent with the typed experiment_created payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.addExperiment({
          sessionId: SESSION_ID,
          testsHypothesisId: HYP_ID,
          design: "replay 1000 requests with empty cache, count NPEs",
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("experiment_created");
    expect(input?.payload).toEqual({
      tests_hypothesis_id: HYP_ID,
      design: "replay 1000 requests with empty cache, count NPEs",
    });
  });

  it("completeExperiment calls SessionService.appendEvent with the typed experiment_completed payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.completeExperiment({
          sessionId: SESSION_ID,
          experimentId: EXPERIMENT_ID,
          resultSummary: "997/1000 reproduced",
          supports: [HYP_ID],
          contradicts: [],
          actor: { name: "bot", type: "worker" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("experiment_completed");
    expect(input?.payload).toEqual({
      result_summary: "997/1000 reproduced",
      supports: [HYP_ID],
      contradicts: [],
    });
  });

  it("completeExperiment defaults supports and contradicts to empty arrays when omitted", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.completeExperiment({
          sessionId: SESSION_ID,
          experimentId: EXPERIMENT_ID,
          resultSummary: "no signal",
          actor: { name: "bot", type: "worker" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("experiment_completed");
    expect(input?.payload).toEqual({
      result_summary: "no signal",
      supports: [],
      contradicts: [],
    });
  });

  // ===========================================================================
  // 3a-5: decision
  // ===========================================================================
  it("proposeDecision calls SessionService.appendEvent with the typed decision_proposed payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.proposeDecision({
          sessionId: SESSION_ID,
          text: "warm the session cache on every restart",
          basedOnConclusionIds: [CONCLUSION_ID],
          actor: { name: "alice", type: "human" },
          confidence: 0.65,
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("decision_proposed");
    expect(input?.payload).toEqual({
      text: "warm the session cache on every restart",
      based_on_conclusion_ids: [CONCLUSION_ID],
    });
    expect(input?.confidence).toBe(0.65);
  });

  it("acceptDecision calls SessionService.appendEvent with the typed decision_accepted payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.acceptDecision({
          sessionId: SESSION_ID,
          decisionId: DECISION_ID,
          basedOnConclusionIds: [CONCLUSION_ID],
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("decision_accepted");
    expect(input?.payload).toEqual({ based_on_conclusion_ids: [CONCLUSION_ID] });
  });

  it("rejectDecision calls SessionService.appendEvent with the typed decision_rejected payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.rejectDecision({
          sessionId: SESSION_ID,
          decisionId: DECISION_ID,
          reason: "too costly to warm the cache on every restart",
          actor: { name: "bob", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("decision_rejected");
    expect(input?.payload).toEqual({ reason: "too costly to warm the cache on every restart" });
  });

  it("supersedeDecision calls SessionService.appendEvent with the typed decision_superseded payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);
    const NEW_DEC_ID = "01DEC00000000000000000099";

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.supersedeDecision({
          sessionId: SESSION_ID,
          decisionId: DECISION_ID,
          supersededByDecisionId: NEW_DEC_ID,
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("decision_superseded");
    expect(input?.payload).toEqual({ superseded_by_decision_id: NEW_DEC_ID });
  });

  // ===========================================================================
  // 3a-6: conclusion / verification / artifact
  // ===========================================================================
  it("proposeConclusion calls SessionService.appendEvent with the typed conclusion_proposed payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.proposeConclusion({
          sessionId: SESSION_ID,
          text: "The NPE is caused by a missing cache-warm step",
          actor: { name: "alice", type: "human" },
          confidence: 0.9,
          linkedHypothesisId: HYP_ID,
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("conclusion_proposed");
    expect(input?.payload).toEqual({ text: "The NPE is caused by a missing cache-warm step" });
    expect(input?.confidence).toBe(0.9);
    expect(input?.linkedHypothesisId).toBe(HYP_ID);
  });

  it("verifyConclusion calls SessionService.appendEvent with the typed conclusion_verified payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.verifyConclusion({
          sessionId: SESSION_ID,
          conclusionId: CONCLUSION_ID,
          verificationId: VERIFICATION_ID,
          supportingEvidenceIds: ["EV1", "EV2"],
          actor: { name: "alice", type: "human" },
          confidence: 0.95,
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("conclusion_verified");
    expect(input?.payload).toEqual({
      verification_id: VERIFICATION_ID,
      supporting_evidence_ids: ["EV1", "EV2"],
    });
    expect(input?.confidence).toBe(0.95);
  });

  it("rejectConclusion calls SessionService.appendEvent with the typed conclusion_rejected payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.rejectConclusion({
          sessionId: SESSION_ID,
          conclusionId: CONCLUSION_ID,
          reason: "the experiment was confounded by a deploy mid-run",
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("conclusion_rejected");
    expect(input?.payload).toEqual({ reason: "the experiment was confounded by a deploy mid-run" });
  });

  it("verify calls SessionService.appendEvent with the typed verification_started payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.verify({
          sessionId: SESSION_ID,
          command: "pnpm test",
          type: "test",
          linkedHypothesisId: HYP_ID,
          actor: { name: "ci", type: "system" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("verification_started");
    expect(input?.payload).toEqual({
      command: "pnpm test",
      type: "test",
      linked_hypothesis_id: HYP_ID,
    });
    expect(input?.linkedHypothesisId).toBe(HYP_ID);
  });

  it("cancelVerification calls SessionService.appendEvent with the typed verification_cancelled payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.cancelVerification({
          sessionId: SESSION_ID,
          verificationId: VERIFICATION_ID,
          reason: "build farm down",
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("verification_cancelled");
    expect(input?.payload).toEqual({ reason: "build farm down" });
  });

  it("attachArtifact calls SessionService.appendEvent with the typed artifact_attached payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.attachArtifact({
          sessionId: SESSION_ID,
          artifactId: ARTIFACT_ID,
          role: "evidence",
          actor: { name: "alice", type: "human" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("artifact_attached");
    expect(input?.payload).toEqual({
      artifact_id: ARTIFACT_ID,
      role: "evidence",
    });
  });

  // ===========================================================================
  // 3a-7: edge
  // ===========================================================================
  it("addEdge calls SessionService.appendEvent with the typed edge_created payload", async () => {
    const captured: Captured = { inputs: [], count: 0, edges: [] };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.addEdge({
          sessionId: SESSION_ID,
          edgeType: "supports",
          fromEntityType: "finding",
          fromEntityId: "01FIND00000000000000000000",
          toEntityType: "hypothesis",
          toEntityId: HYP_ID,
          actor: { name: "alice", type: "human" },
          confidence: 0.8,
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("edge_created");
    expect(input?.payload).toEqual({
      edge_type: "supports",
      from_entity_type: "finding",
      from_entity_id: "01FIND00000000000000000000",
      to_entity_type: "hypothesis",
      to_entity_id: HYP_ID,
    });
    expect(input?.confidence).toBe(0.8);
  });

  it("listEdges reads the session's edge state and flattens it to EdgeListRow", async () => {
    const captured: Captured = {
      inputs: [],
      count: 0,
      edges: [
        {
          id: "01EDG00000000000000000000",
          edge_type: "supports",
          from_entity_type: "finding",
          from_entity_id: "01FIND00000000000000000000",
          to_entity_type: "hypothesis",
          to_entity_id: HYP_ID,
          created_at: "2026-06-15T00:00:00.000Z",
        },
        {
          id: "01EDG00000000000000000001",
          edge_type: "contradicts",
          from_entity_type: "experiment",
          from_entity_id: "01EXP00000000000000000000",
          to_entity_type: "hypothesis",
          to_entity_id: HYP_ID,
          created_at: "2026-06-15T00:01:00.000Z",
        },
      ],
    };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.listEdges({ sessionId: SESSION_ID });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        ReadonlyArray<{
          edgeType: string;
          fromEntityType: string;
          fromEntityId: string;
          toEntityType: string;
          toEntityId: string;
          eventId: string;
          createdAt: string;
        }>,
        unknown,
        never
      >,
    );

    // listEdges is a pure read: no appendEvent call.
    expect(captured.count).toBe(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      edgeType: "supports",
      fromEntityType: "finding",
      fromEntityId: "01FIND00000000000000000000",
      toEntityType: "hypothesis",
      toEntityId: HYP_ID,
      eventId: "01EDG00000000000000000000",
      createdAt: "2026-06-15T00:00:00.000Z",
    });
    expect(rows[1]?.edgeType).toBe("contradicts");
  });
});
