import { describe, expect, it } from "vitest";
import { Context, Effect, Layer } from "effect";
import { CognitionService, CognitionServiceLive, SessionService } from "../src";

/**
 * Test the CognitionService shell in isolation: the service's
 * `recordObservation` method must call `SessionService.appendEvent`
 * with the correct `AppendEventInput` shape (a single `text` payload
 * field per `ObservationRecordedPayload`).
 *
 * We mock `SessionService` with a Layer that records the call and
 * returns a synthetic `EventRow`. No SQLite, no real services — the
 * goal is to validate the shell, not the chokepoint.
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

  const makeMockSessionsLayer = (captured: {
    input?: AppendEventInput;
    count: number;
  }): Layer.Layer<SessionService> => {
    const layer = Layer.succeed(SessionService)({
      create: () => Effect.die("not used in this test") as never,
      list: () => Effect.die("not used in this test") as never,
      getByGoalOrId: () => Effect.die("not used in this test") as never,
      pause: () => Effect.die("not used in this test") as never,
      close: () => Effect.die("not used in this test") as never,
      resume: () => Effect.die("not used in this test") as never,
      show: () => Effect.die("not used in this test") as never,
      takeSnapshot: () => Effect.die("not used in this test") as never,
      appendEvent: (input) => {
        captured.input = input;
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

  it("recordObservation calls SessionService.appendEvent with the typed observation payload", async () => {
    const captured: { input?: AppendEventInput; count: number } = { count: 0 };
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
    expect(captured.input).toBeDefined();
    expect(captured.input?.type).toBe("observation_recorded");
    expect(captured.input?.sessionId).toBe(SESSION_ID);
    expect(captured.input?.payload).toEqual({ text: "got NPE in UserService" });
    expect(captured.input?.actor).toEqual({ name: "alice", type: "human" });
    // Optional fields are absent (not undefined) when not supplied.
    expect(captured.input?.confidence).toBeUndefined();
    expect(captured.input?.linkedHypothesisId).toBeUndefined();
    expect(result.id).toBe(EVENT_ID);
    expect(result.type).toBe("observation_recorded");
  });
});
