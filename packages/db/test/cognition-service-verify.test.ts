/**
 * 6bz.2 — pass/fail/error/rerun resolution methods on CognitionService.
 *
 * Same isolation pattern as cognition-service.test.ts: a mock
 * SessionService Layer captures every appendEvent call, the
 * CognitionServiceLive layer is built on top of it, and the assertion
 * surface is the captured input list.
 *
 * Each terminal method must:
 *   - append the right typed v1.1.0 payload,
 *   - thread `parentVerificationId` into the cross-cutting field on
 *     the event row (so the chain back to the originating
 *     `verification_started` row is queryable from the events table),
 *   - default omitted outcome fields to `null` / `0` per the schema.
 *
 * `rerunVerification` additionally has to put `parent_verification_id`
 * in the payload (reducer reads it from there to copy the parent's
 * command/type/linked_hypothesis_id).
 */

import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { CognitionService, CognitionServiceLive, SessionService } from "../src";
import { VerificationErrored } from "../src/errors";

describe("CognitionService — verification resolution (6bz.2)", () => {
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
  const VERIFICATION_ID = "01VER00000000000000000000";
  const ARTIFACT_ID = "01ART00000000000000000000";

  type Captured = {
    inputs: AppendEventInput[];
    count: number;
  };

  const makeMockSessionsLayer = (captured: Captured): Layer.Layer<SessionService> => {
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
        captured.inputs.push(input);
        captured.count += 1;
        return Effect.succeed({
          event: {
            id: EVENT_ID,
            project_id: "01PROJ00000000000000000000",
            session_id: input.sessionId,
            actor_id: "01ACT0000000000000000000000",
            type: input.type,
            version: "1.1.0",
            payload_json: JSON.stringify(input.payload),
            source_json: null,
            artifact_refs_json: null,
            causation_id: null,
            correlation_id: null,
            confidence: input.confidence ?? null,
            parent_verification_id: input.parentVerificationId ?? null,
            linked_hypothesis_id: input.linkedHypothesisId ?? null,
            created_at: "2026-06-16T00:00:00.000Z",
          },
          snapshotTaken: false,
        } as SessionAppendEventResult);
      },
    });
    return layer;
  };

  // ===========================================================================
  // passVerification
  // ===========================================================================
  it("passVerification appends verification_passed with full v1.1.0 outcome fields", async () => {
    const captured: Captured = { inputs: [], count: 0 };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.passVerification({
          sessionId: SESSION_ID,
          verificationId: VERIFICATION_ID,
          exitCode: 0,
          durationMs: 1234,
          stdoutExcerpt: "ok",
          createdArtifactId: ARTIFACT_ID,
          actor: { name: "ci", type: "system" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        { id: string; type: string; parent_verification_id: string | null },
        unknown,
        never
      >,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("verification_passed");
    expect(input?.sessionId).toBe(SESSION_ID);
    expect(input?.payload).toEqual({
      exit_code: 0,
      duration_ms: 1234,
      stdout_excerpt: "ok",
      created_artifact_id: ARTIFACT_ID,
    });
    expect(input?.parentVerificationId).toBe(VERIFICATION_ID);
    expect(input?.actor).toEqual({ name: "ci", type: "system" });
    expect(result.type).toBe("verification_passed");
    expect(result.parent_verification_id).toBe(VERIFICATION_ID);
  });

  it("passVerification defaults missing outcome fields (exit_code -> 0, others -> null)", async () => {
    const captured: Captured = { inputs: [], count: 0 };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.passVerification({
          sessionId: SESSION_ID,
          verificationId: VERIFICATION_ID,
          actor: { name: "ci", type: "system" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.payload).toEqual({
      exit_code: 0,
      duration_ms: null,
      stdout_excerpt: null,
      created_artifact_id: null,
    });
    expect(input?.parentVerificationId).toBe(VERIFICATION_ID);
  });

  // ===========================================================================
  // failVerification
  // ===========================================================================
  it("failVerification appends verification_failed with stderr_excerpt + full v1.1.0 fields", async () => {
    const captured: Captured = { inputs: [], count: 0 };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.failVerification({
          sessionId: SESSION_ID,
          verificationId: VERIFICATION_ID,
          stderrExcerpt: "ReferenceError: foo is not defined",
          exitCode: 1,
          durationMs: 800,
          stdoutExcerpt: "running...",
          createdArtifactId: ARTIFACT_ID,
          actor: { name: "ci", type: "system" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("verification_failed");
    expect(input?.payload).toEqual({
      stderr_excerpt: "ReferenceError: foo is not defined",
      exit_code: 1,
      duration_ms: 800,
      stdout_excerpt: "running...",
      created_artifact_id: ARTIFACT_ID,
    });
    expect(input?.parentVerificationId).toBe(VERIFICATION_ID);
  });

  it("failVerification defaults optional outcome fields to null", async () => {
    const captured: Captured = { inputs: [], count: 0 };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.failVerification({
          sessionId: SESSION_ID,
          verificationId: VERIFICATION_ID,
          stderrExcerpt: "boom",
          actor: { name: "ci", type: "system" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    const input = captured.inputs[0];
    expect(input?.payload).toEqual({
      stderr_excerpt: "boom",
      exit_code: null,
      duration_ms: null,
      stdout_excerpt: null,
      created_artifact_id: null,
    });
  });

  // ===========================================================================
  // errorVerification
  // ===========================================================================
  it("errorVerification appends verification_errored with error + error_code + duration", async () => {
    const captured: Captured = { inputs: [], count: 0 };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.errorVerification({
          sessionId: SESSION_ID,
          verificationId: VERIFICATION_ID,
          error: "spawn no-such-cmd ENOENT",
          errorCode: "enoent",
          durationMs: 5,
          actor: { name: "ci", type: "system" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("verification_errored");
    expect(input?.payload).toEqual({
      error: "spawn no-such-cmd ENOENT",
      duration_ms: 5,
      error_code: "enoent",
    });
    expect(input?.parentVerificationId).toBe(VERIFICATION_ID);
  });

  it("errorVerification omits error_code from payload when not supplied", async () => {
    const captured: Captured = { inputs: [], count: 0 };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.errorVerification({
          sessionId: SESSION_ID,
          verificationId: VERIFICATION_ID,
          error: "generic spawn failure",
          actor: { name: "ci", type: "system" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    const input = captured.inputs[0];
    expect(input?.payload).toEqual({
      error: "generic spawn failure",
      duration_ms: null,
    });
    expect((input?.payload as { error_code?: string }).error_code).toBeUndefined();
  });

  // ===========================================================================
  // rerunVerification
  // ===========================================================================
  it("rerunVerification appends verification_rerun with parent_verification_id in payload + row", async () => {
    const captured: Captured = { inputs: [], count: 0 };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.rerunVerification({
          sessionId: SESSION_ID,
          parentVerificationId: VERIFICATION_ID,
          durationMs: 42,
          actor: { name: "ci", type: "system" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        { id: string; type: string; parent_verification_id: string | null },
        unknown,
        never
      >,
    );

    expect(captured.count).toBe(1);
    const input = captured.inputs[0];
    expect(input?.type).toBe("verification_rerun");
    expect(input?.payload).toEqual({
      parent_verification_id: VERIFICATION_ID,
      duration_ms: 42,
    });
    // both: the cross-cutting row field AND the payload must carry
    // the parent id (the reducer reads from payload; queries against
    // the events table read from the column).
    expect(input?.parentVerificationId).toBe(VERIFICATION_ID);
    expect(result.parent_verification_id).toBe(VERIFICATION_ID);
  });

  it("rerunVerification defaults duration_ms to null when omitted", async () => {
    const captured: Captured = { inputs: [], count: 0 };
    const mockSessions = makeMockSessionsLayer(captured);
    const layer = Layer.provide(CognitionServiceLive, mockSessions);

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CognitionService;
        return yield* svc.rerunVerification({
          sessionId: SESSION_ID,
          parentVerificationId: VERIFICATION_ID,
          actor: { name: "ci", type: "system" },
        });
      }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<unknown, unknown, never>,
    );

    expect(captured.inputs[0]?.payload).toEqual({
      parent_verification_id: VERIFICATION_ID,
      duration_ms: null,
    });
  });

  // ===========================================================================
  // VerificationErrored tagged error
  // ===========================================================================
  it("VerificationErrored tagged error carries verificationId, error, optional errorCode", () => {
    const err = new VerificationErrored({
      verificationId: VERIFICATION_ID,
      error: "spawn ENOENT",
      errorCode: "enoent",
    });
    expect(err._tag).toBe("VerificationErrored");
    expect(err.verificationId).toBe(VERIFICATION_ID);
    expect(err.error).toBe("spawn ENOENT");
    expect(err.errorCode).toBe("enoent");

    const errNoCode = new VerificationErrored({
      verificationId: VERIFICATION_ID,
      error: "generic",
    });
    expect(errNoCode._tag).toBe("VerificationErrored");
    expect(errNoCode.errorCode).toBeUndefined();
  });
});
