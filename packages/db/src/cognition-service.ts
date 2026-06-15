/**
 * CognitionService — high-level methods that produce cognition-entity
 * events (observation, finding, hypothesis, theory, experiment,
 * decision, conclusion, verification, artifact, edge). Each method
 * builds a typed payload from positional args and routes the append
 * through `SessionService.appendEvent` — the single chokepoint that
 * the constraint engine (phase 3c) hooks into.
 *
 * The shell was seeded by bead 3a-1 with `recordObservation`; the
 * per-entity follow-up beads (3a-2 .. 3a-7) add the rest. The shape
 * exists now so the constraint engine has a stable caller signature
 * to evaluate against.
 *
 * Note: this service does NOT call `EventStore.append` directly. The
 * redaction + auto-snapshot path lives in `SessionService.appendEvent`,
 * and constraint evaluation (phase 3c) lives there too. Keeping the
 * chokepoint single is the point.
 */

import { Context, Effect, Layer } from "effect";
import type { ActorType } from "./actor";
import type { EventRow } from "./schema/rows";
import { SessionService, type SessionError } from "./session-service";

type SessionServiceT = Context.Tag.Service<typeof SessionService>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

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

/**
 * The closed set of reasons a hypothesis can be rejected.
 * Mirrors the `reason_type` literal in `HypothesisRejectedPayload`.
 */
export type HypothesisRejectReasonType = "evidence" | "superseded" | "constraint";

export interface ProposeHypothesisInput {
  readonly sessionId: string;
  readonly title: string;
  readonly text: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly confidence?: number;
}

export interface WeakenHypothesisInput {
  readonly sessionId: string;
  readonly hypothesisId: string;
  readonly reason: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface RejectHypothesisInput {
  readonly sessionId: string;
  readonly hypothesisId: string;
  readonly reasonType: HypothesisRejectReasonType;
  readonly supersededById?: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface PromoteHypothesisInput {
  readonly sessionId: string;
  readonly hypothesisId: string;
  readonly promotedToTheoryId: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface AddTheoryInput {
  readonly sessionId: string;
  readonly title: string;
  readonly text: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly confidence?: number;
}

export interface UpdateTheoryInput {
  readonly sessionId: string;
  readonly theoryId: string;
  readonly text: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface MergeTheoryInput {
  readonly sessionId: string;
  readonly theoryId: string;
  readonly mergedIntoTheoryId: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface ArchiveTheoryInput {
  readonly sessionId: string;
  readonly theoryId: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface AddExperimentInput {
  readonly sessionId: string;
  readonly testsHypothesisId: string;
  readonly design: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface CompleteExperimentInput {
  readonly sessionId: string;
  readonly experimentId: string;
  readonly resultSummary: string;
  readonly supports?: ReadonlyArray<string>;
  readonly contradicts?: ReadonlyArray<string>;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface ProposeDecisionInput {
  readonly sessionId: string;
  readonly text: string;
  readonly basedOnConclusionIds: ReadonlyArray<string>;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly confidence?: number;
}

export interface AcceptDecisionInput {
  readonly sessionId: string;
  readonly decisionId: string;
  readonly basedOnConclusionIds: ReadonlyArray<string>;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface RejectDecisionInput {
  readonly sessionId: string;
  readonly decisionId: string;
  readonly reason: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface SupersedeDecisionInput {
  readonly sessionId: string;
  readonly decisionId: string;
  readonly supersededByDecisionId: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface ProposeConclusionInput {
  readonly sessionId: string;
  readonly text: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly confidence?: number;
  readonly linkedHypothesisId?: string;
}

export interface VerifyConclusionInput {
  readonly sessionId: string;
  readonly conclusionId: string;
  readonly verificationId: string;
  readonly supportingEvidenceIds: ReadonlyArray<string>;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly confidence?: number;
}

export interface RejectConclusionInput {
  readonly sessionId: string;
  readonly conclusionId: string;
  readonly reason: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export type VerificationType = "test" | "lint" | "build" | "exec" | "typecheck";

export interface VerifyInput {
  readonly sessionId: string;
  readonly command: string;
  readonly type: VerificationType;
  readonly linkedHypothesisId?: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly parentVerificationId?: string;
}

export interface CancelVerificationInput {
  readonly sessionId: string;
  readonly verificationId: string;
  readonly reason: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export type ArtifactRole = "evidence" | "code" | "log" | "config";

export interface AttachArtifactInput {
  readonly sessionId: string;
  readonly artifactId: string;
  readonly role: ArtifactRole;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

export interface AddEdgeInput {
  readonly sessionId: string;
  readonly edgeType: string;
  readonly fromEntityType: string;
  readonly fromEntityId: string;
  readonly toEntityType: string;
  readonly toEntityId: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly confidence?: number;
}

/**
 * Edge list row — the shape `listEdges` returns to callers. The fields
 * are derived from `SessionState.edges` (`EdgeState`) but flattened to
 * the wire shape the CLI / API surfaces. `eventId` and `createdAt`
 * ride along on each row so the consumer can correlate the edge back
 * to its source event in the log.
 */
export interface EdgeListRow {
  readonly edgeType: string;
  readonly fromEntityType: string;
  readonly fromEntityId: string;
  readonly toEntityType: string;
  readonly toEntityId: string;
  readonly eventId: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

export interface CognitionServiceShape {
  // --- observation (3a-1) ---
  /**
   * Record a free-form observation. Builds the
   * `observation_recorded` event payload (a single `text` field per
   * `ObservationRecordedPayload`) and forwards through
   * `SessionService.appendEvent`.
   */
  readonly recordObservation: (
    input: RecordObservationInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;

  // --- finding (3a-2) ---
  /**
   * Record a finding that synthesises one or
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

  // --- hypothesis (3a-3) ---
  /**
   * Propose a hypothesis. Builds the `hypothesis_created` event
   * payload (`{ title, text }` per `HypothesisCreatedPayload`) and
   * forwards through `SessionService.appendEvent`.
   */
  readonly proposeHypothesis: (
    input: ProposeHypothesisInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Mark a hypothesis as weakened. Builds the `hypothesis_weakened`
   * event payload (`{ reason }` per `HypothesisWeakenedPayload`) and
   * forwards through `SessionService.appendEvent`. The hypothesis id
   * is recorded via the cross-cutting `linkedHypothesisId` field on
   * the event row, not in the payload.
   */
  readonly weakenHypothesis: (
    input: WeakenHypothesisInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Reject a hypothesis. Builds the `hypothesis_rejected` event
   * payload (`{ reason_type, superseded_by_id }` per
   * `HypothesisRejectedPayload`) and forwards through
   * `SessionService.appendEvent`.
   */
  readonly rejectHypothesis: (
    input: RejectHypothesisInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Promote a hypothesis to a theory. Builds the
   * `hypothesis_promoted` event payload
   * (`{ promoted_to_theory_id }` per `HypothesisPromotedPayload`)
   * and forwards through `SessionService.appendEvent`. The hypothesis
   * id is recorded via the cross-cutting `linkedHypothesisId` field.
   */
  readonly promoteHypothesis: (
    input: PromoteHypothesisInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;

  // --- theory (3a-4) ---
  /**
   * Add a new theory to the session. Builds the `theory_created`
   * payload (`{ title, text }` per `TheoryCreatedPayload`) and
   * forwards through `SessionService.appendEvent`.
   */
  readonly addTheory: (
    input: AddTheoryInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Update an existing theory's body. Builds the `theory_updated`
   * payload (`{ text }` per `TheoryUpdatedPayload`) and forwards
   * through `SessionService.appendEvent`.
   */
  readonly updateTheory: (
    input: UpdateTheoryInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Mark a theory as merged into another. Builds the
   * `theory_merged` payload
   * (`{ merged_into_theory_id }` per `TheoryMergedPayload`) and
   * forwards through `SessionService.appendEvent`.
   */
  readonly mergeTheory: (
    input: MergeTheoryInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Archive a theory. Builds the `theory_archived` payload (empty
   * per `TheoryArchivedPayload`) and forwards through
   * `SessionService.appendEvent`.
   */
  readonly archiveTheory: (
    input: ArchiveTheoryInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;

  // --- experiment (3a-4) ---
  /**
   * Add a new experiment to the session. Builds the
   * `experiment_created` payload
   * (`{ tests_hypothesis_id, design }` per `ExperimentCreatedPayload`)
   * and forwards through `SessionService.appendEvent`.
   */
  readonly addExperiment: (
    input: AddExperimentInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Complete an experiment. Builds the `experiment_completed`
   * payload
   * (`{ result_summary, supports?, contradicts? }` per
   * `ExperimentCompletedPayload`) and forwards through
   * `SessionService.appendEvent`. The optional arrays default to
   * empty lists.
   */
  readonly completeExperiment: (
    input: CompleteExperimentInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;

  // --- decision (3a-5) ---
  /**
   * Propose a decision. Builds the `decision_proposed` event payload
   * (`{ text, based_on_conclusion_ids }` per `DecisionProposedPayload`)
   * and forwards through `SessionService.appendEvent`.
   */
  readonly proposeDecision: (
    input: ProposeDecisionInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Accept a decision. Builds the `decision_accepted` event payload
   * (`{ based_on_conclusion_ids }` per `DecisionAcceptedPayload`) and
   * forwards through `SessionService.appendEvent`.
   */
  readonly acceptDecision: (
    input: AcceptDecisionInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Reject a decision. Builds the `decision_rejected` event payload
   * (`{ reason }` per `DecisionRejectedPayload`) and forwards through
   * `SessionService.appendEvent`.
   */
  readonly rejectDecision: (
    input: RejectDecisionInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Supersede a decision. Builds the `decision_superseded` event
   * payload (`{ superseded_by_decision_id }` per
   * `DecisionSupersededPayload`) and forwards through
   * `SessionService.appendEvent`.
   */
  readonly supersedeDecision: (
    input: SupersedeDecisionInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;

  // --- conclusion / verification / artifact (3a-6) ---
  /**
   * Propose a conclusion. Builds the `conclusion_proposed` event
   * payload (`{ text }` per `ConclusionProposedPayload`) and forwards
   * through `SessionService.appendEvent`.
   */
  readonly proposeConclusion: (
    input: ProposeConclusionInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Verify a previously proposed conclusion. Builds the
   * `conclusion_verified` event payload
   * (`{ verification_id, supporting_evidence_ids }` per
   * `ConclusionVerifiedPayload`).
   */
  readonly verifyConclusion: (
    input: VerifyConclusionInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Reject a previously proposed conclusion. Builds the
   * `conclusion_rejected` event payload (`{ reason }` per
   * `ConclusionRejectedPayload`).
   */
  readonly rejectConclusion: (
    input: RejectConclusionInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Start a verification. Builds the `verification_started` event
   * payload (`{ command, type, linked_hypothesis_id }` per
   * `VerificationStartedPayload`).
   */
  readonly verify: (
    input: VerifyInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Cancel an in-flight verification. Builds the
   * `verification_cancelled` event payload (`{ reason }` per
   * `VerificationCancelledPayload`).
   */
  readonly cancelVerification: (
    input: CancelVerificationInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;
  /**
   * Attach an artifact to the session. Builds the
   * `artifact_attached` event payload (`{ artifact_id, role }` per
   * `ArtifactAttachedPayload`).
   */
  readonly attachArtifact: (
    input: AttachArtifactInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;

  // --- edge (3a-7) ---
  /**
   * Add a typed edge between two entities in a session. Builds the
   * `edge_created` event payload (5 string fields per
   * `EdgeCreatedPayload`: `edge_type`, `from_entity_type`,
   * `from_entity_id`, `to_entity_type`, `to_entity_id`) and forwards
   * through `SessionService.appendEvent`.
   */
  readonly addEdge: (
    input: AddEdgeInput,
  ) => Effect.Effect<EventRow, SessionError, SessionService>;

  /**
   * Read the edges currently held in the session's derived state.
   * Pure read: no event is appended. Goes through `SessionService.show`
   * which already runs the snapshot+tail replay (so the returned array
   * reflects every `edge_created` event ever applied to the session,
   * not just the ones still in the in-memory cache).
   */
  readonly listEdges: (
    input: { readonly sessionId: string },
  ) => Effect.Effect<ReadonlyArray<EdgeListRow>, SessionError, SessionService>;
}

export class CognitionService extends Context.Tag("@cognit/db/CognitionService")<
  CognitionService,
  CognitionServiceShape
>() {}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

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
      // --- observation (3a-1) ---
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

      // --- finding (3a-2) ---
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

      // --- hypothesis (3a-3) ---
      proposeHypothesis: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "hypothesis_created",
            payload: { title: input.title, text: input.text },
            actor: input.actor,
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          });
          return event;
        }),
      weakenHypothesis: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "hypothesis_weakened",
            payload: { reason: input.reason },
            actor: input.actor,
            linkedHypothesisId: input.hypothesisId,
          });
          return event;
        }),
      rejectHypothesis: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "hypothesis_rejected",
            payload: {
              reason_type: input.reasonType,
              superseded_by_id: input.supersededById ?? null,
            },
            actor: input.actor,
            linkedHypothesisId: input.hypothesisId,
          });
          return event;
        }),
      promoteHypothesis: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "hypothesis_promoted",
            payload: { promoted_to_theory_id: input.promotedToTheoryId },
            actor: input.actor,
            linkedHypothesisId: input.hypothesisId,
          });
          return event;
        }),

      // --- theory (3a-4) ---
      addTheory: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "theory_created",
            payload: { title: input.title, text: input.text },
            actor: input.actor,
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          });
          return event;
        }),
      updateTheory: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "theory_updated",
            payload: { text: input.text },
            actor: input.actor,
          });
          return event;
        }),
      mergeTheory: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "theory_merged",
            payload: { merged_into_theory_id: input.mergedIntoTheoryId },
            actor: input.actor,
          });
          return event;
        }),
      archiveTheory: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "theory_archived",
            payload: {},
            actor: input.actor,
          });
          return event;
        }),

      // --- experiment (3a-4) ---
      addExperiment: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "experiment_created",
            payload: {
              tests_hypothesis_id: input.testsHypothesisId,
              design: input.design,
            },
            actor: input.actor,
          });
          return event;
        }),
      completeExperiment: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "experiment_completed",
            payload: {
              result_summary: input.resultSummary,
              supports: input.supports ?? [],
              contradicts: input.contradicts ?? [],
            },
            actor: input.actor,
          });
          return event;
        }),

      // --- decision (3a-5) ---
      proposeDecision: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "decision_proposed",
            payload: {
              text: input.text,
              based_on_conclusion_ids: [...input.basedOnConclusionIds],
            },
            actor: input.actor,
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          });
          return event;
        }),
      acceptDecision: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "decision_accepted",
            payload: {
              based_on_conclusion_ids: [...input.basedOnConclusionIds],
            },
            actor: input.actor,
          });
          return event;
        }),
      rejectDecision: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "decision_rejected",
            payload: {
              reason: input.reason,
            },
            actor: input.actor,
          });
          return event;
        }),
      supersedeDecision: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "decision_superseded",
            payload: {
              superseded_by_decision_id: input.supersededByDecisionId,
            },
            actor: input.actor,
          });
          return event;
        }),

      // --- conclusion / verification / artifact (3a-6) ---
      proposeConclusion: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "conclusion_proposed",
            payload: { text: input.text },
            actor: input.actor,
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
            ...(input.linkedHypothesisId !== undefined
              ? { linkedHypothesisId: input.linkedHypothesisId }
              : {}),
          });
          return event;
        }),
      verifyConclusion: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "conclusion_verified",
            payload: {
              verification_id: input.verificationId,
              supporting_evidence_ids: [...input.supportingEvidenceIds],
            },
            actor: input.actor,
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          });
          return event;
        }),
      rejectConclusion: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "conclusion_rejected",
            payload: { reason: input.reason },
            actor: input.actor,
          });
          return event;
        }),
      verify: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "verification_started",
            payload: {
              command: input.command,
              type: input.type,
              linked_hypothesis_id: input.linkedHypothesisId ?? null,
            },
            actor: input.actor,
            ...(input.parentVerificationId !== undefined
              ? { parentVerificationId: input.parentVerificationId }
              : {}),
            ...(input.linkedHypothesisId !== undefined
              ? { linkedHypothesisId: input.linkedHypothesisId }
              : {}),
          });
          return event;
        }),
      cancelVerification: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "verification_cancelled",
            payload: { reason: input.reason },
            actor: input.actor,
          });
          return event;
        }),
      attachArtifact: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "artifact_attached",
            payload: {
              artifact_id: input.artifactId,
              role: input.role,
            },
            actor: input.actor,
          });
          return event;
        }),

      // --- edge (3a-7) ---
      addEdge: (input) =>
        Effect.gen(function* () {
          const { event } = yield* sessions.appendEvent({
            sessionId: input.sessionId,
            type: "edge_created",
            payload: {
              edge_type: input.edgeType,
              from_entity_type: input.fromEntityType,
              from_entity_id: input.fromEntityId,
              to_entity_type: input.toEntityType,
              to_entity_id: input.toEntityId,
            },
            actor: input.actor,
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          });
          return event;
        }),
      listEdges: (input) =>
        Effect.gen(function* () {
          const { state } = yield* sessions.show(input.sessionId);
          const rows: EdgeListRow[] = state.edges.map((e) => ({
            edgeType: e.edge_type,
            fromEntityType: e.from_entity_type,
            fromEntityId: e.from_entity_id,
            toEntityType: e.to_entity_type,
            toEntityId: e.to_entity_id,
            eventId: e.id,
            createdAt: e.created_at,
          }));
          return rows;
        }),
    };
  }),
);
