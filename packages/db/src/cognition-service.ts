/**
 * CognitionService — high-level methods that produce cognition-entity
 * events (observation, finding, hypothesis, theory, ...). Each method
 * builds a typed payload from positional args and routes the append
 * through `SessionService.appendEvent` — the single chokepoint that
 * the constraint engine (phase 3c) will hook into.
 *
 * Bead 3a-1 ships the shell with `recordObservation`.
 * Bead 3a-2 adds `recordFinding`.
 * Per-entity follow-up beads (3a-3 .. 3a-7) add the rest. The shape
 * exists now so the constraint engine has a stable caller signature
 * to evaluate against.
 *
 * Note: this service does NOT call `EventStore.append` directly. The
 * redaction + auto-snapshot path lives in `SessionService.appendEvent`,
 * and constraint evaluation (phase 3c) will live there too. Keeping
 * the chokepoint single is the point.
 */

import { Context, Effect, Layer } from "effect";
import type { ActorType } from "./actor";
import type { EventRow } from "./schema/rows";
import { SessionService, type SessionError } from "./session-service";

type SessionServiceT = Context.Tag.Service<typeof SessionService>;

export interface RecordObservationInput {
  readonly sessionId: string;
  readonly text: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly confidence?: number;
  readonly linkedHypothesisId?: string;
}

export interface RecordFindingInput {
  readonly sessionId: string;
  readonly text: string;
  readonly relatedObservationIds?: ReadonlyArray<string>;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly confidence?: number;
}

export interface CognitionServiceShape {
  /**
   * Record a free-form observation. Builds the
   * `observation_recorded` event payload (a single `text` field per
   * `ObservationRecordedPayload`) and forwards through
   * `SessionService.appendEvent`.
   */
  readonly recordObservation: (
    input: RecordObservationInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Record a finding — a synthesized conclusion drawn from one or
   * more observations. Builds the `finding_created` event payload
   * (`text` + optional `related_observation_ids` per
   * `FindingCreatedPayload`) and forwards through
   * `SessionService.appendEvent`. The list of related observation ids
   * is forwarded as-is; the reducer/constraint engine may resolve
   * them in a later phase.
   */
  readonly recordFinding: (
    input: RecordFindingInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
}

export class CognitionService extends Context.Tag("@cognit/db/CognitionService")<
  CognitionService,
  CognitionServiceShape
>() {}

/**
 * Live layer for `CognitionService`. Built on top of `SessionService`
 * (which it yields on the R channel) so callers see the constraint
 * chokepoint in their effect's requirement list.
 */
export const CognitionServiceLive: Layer.Layer<CognitionService, never, SessionService> = Layer.effect(
  CognitionService,
  Effect.gen(function* () {
    const sessions: SessionServiceT = yield* SessionService;
    return {
      recordObservation: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "observation_recorded",
            payload: { text: input.text },
            actor: input.actor,
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
            ...(input.linkedHypothesisId !== undefined
              ? { linkedHypothesisId: input.linkedHypothesisId }
              : {}),
          });
          return event;
        }),
      recordFinding: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "finding_created",
            payload: {
              text: input.text,
              related_observation_ids: input.relatedObservationIds ?? [],
            },
            actor: input.actor,
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          });
          return event;
        }),
    };
  }),
);
