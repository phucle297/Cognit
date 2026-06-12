import { Schema } from "effect";

/**
 * Current payload schema version. Append always writes this version.
 * On read, `migrate(eventRow, row.version, CURRENT_VERSION)` brings old
 * events up to current. Migrations are pure, additive, and tested.
 */
export const CURRENT_VERSION = "1.0.0" as const;

/**
 * Per-event-type payload Schemas. Each is a Struct with the fields the
 * event type requires per plan.xml <event_types>. Cross-cutting fields
 * (confidence, source, ...) are top-level on the event row, not in payload.
 */

const SessionCreatedPayload = Schema.Struct({
  goal: Schema.String.pipe(Schema.minLength(1)),
  parent_session_id: Schema.NullOr(Schema.String),
});
type SessionCreatedPayload = Schema.Schema.Type<typeof SessionCreatedPayload>;

const SessionPausedPayload = Schema.Struct({});
const SessionClosedPayload = Schema.Struct({});
const SnapshotCreatedPayload = Schema.Struct({
  event_count_up_to: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  state_json: Schema.String,
});
const ObservationRecordedPayload = Schema.Struct({
  text: Schema.String.pipe(Schema.minLength(1)),
});
const FindingCreatedPayload = Schema.Struct({
  text: Schema.String.pipe(Schema.minLength(1)),
  related_observation_ids: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [] as string[],
  }),
});
const HypothesisCreatedPayload = Schema.Struct({
  title: Schema.String.pipe(Schema.minLength(1)),
  text: Schema.String.pipe(Schema.minLength(1)),
});
const HypothesisWeakenedPayload = Schema.Struct({
  reason: Schema.String,
});
const HypothesisRejectedPayload = Schema.Struct({
  reason_type: Schema.Literal("evidence", "superseded", "constraint"),
  superseded_by_id: Schema.NullOr(Schema.String),
});
const HypothesisPromotedPayload = Schema.Struct({
  promoted_to_theory_id: Schema.String,
});
const TheoryCreatedPayload = Schema.Struct({
  title: Schema.String.pipe(Schema.minLength(1)),
  text: Schema.String.pipe(Schema.minLength(1)),
});
const TheoryUpdatedPayload = Schema.Struct({
  text: Schema.String,
});
const TheoryMergedPayload = Schema.Struct({
  merged_into_theory_id: Schema.String,
});
const TheoryArchivedPayload = Schema.Struct({});
const ExperimentCreatedPayload = Schema.Struct({
  tests_hypothesis_id: Schema.String,
  design: Schema.String,
});
const ExperimentCompletedPayload = Schema.Struct({
  result_summary: Schema.String,
  supports: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] as string[] }),
  contradicts: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] as string[] }),
});
const DecisionProposedPayload = Schema.Struct({
  text: Schema.String.pipe(Schema.minLength(1)),
  based_on_conclusion_ids: Schema.Array(Schema.String),
});
const DecisionAcceptedPayload = Schema.Struct({
  based_on_conclusion_ids: Schema.Array(Schema.String),
});
const DecisionRejectedPayload = Schema.Struct({
  reason: Schema.String,
});
const DecisionSupersededPayload = Schema.Struct({
  superseded_by_decision_id: Schema.String,
});
const ConclusionProposedPayload = Schema.Struct({
  text: Schema.String.pipe(Schema.minLength(1)),
});
const ConclusionVerifiedPayload = Schema.Struct({
  verification_id: Schema.String,
  supporting_evidence_ids: Schema.Array(Schema.String),
});
const ConclusionRejectedPayload = Schema.Struct({
  reason: Schema.String,
});
const VerificationStartedPayload = Schema.Struct({
  command: Schema.String,
  type: Schema.Literal("test", "lint", "build", "exec", "typecheck"),
  linked_hypothesis_id: Schema.NullOr(Schema.String),
});
const VerificationPassedPayload = Schema.Struct({});
const VerificationFailedPayload = Schema.Struct({
  stderr_excerpt: Schema.String,
});
const VerificationErroredPayload = Schema.Struct({
  error: Schema.String,
});
const VerificationCancelledPayload = Schema.Struct({
  reason: Schema.String,
});
const VerificationRerunPayload = Schema.Struct({
  parent_verification_id: Schema.String,
});
const ArtifactAttachedPayload = Schema.Struct({
  artifact_id: Schema.String,
  role: Schema.Literal("evidence", "code", "log", "config"),
});
const EdgeCreatedPayload = Schema.Struct({
  edge_type: Schema.String,
  from_entity_type: Schema.String,
  from_entity_id: Schema.String,
  to_entity_type: Schema.String,
  to_entity_id: Schema.String,
});
const ActorRegisteredPayload = Schema.Struct({
  actor_type: Schema.Literal("human", "worker", "system"),
  actor_name: Schema.String.pipe(Schema.minLength(1)),
  trust_score: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(1)),
});
const ConstraintRuleAddedPayload = Schema.Struct({
  rule_id: Schema.String,
  condition_json: Schema.String,
  actions_json: Schema.String,
});
const ConstraintRuleAppliedPayload = Schema.Struct({
  rule_id: Schema.String,
  affected_hypothesis_ids: Schema.Array(Schema.String),
});
const RedactionAppliedPayload = Schema.Struct({
  pattern: Schema.String,
  entity_type: Schema.String,
  entity_id: Schema.NullOr(Schema.String),
  field_path: Schema.String,
});
const ProjectCreatedPayload = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
});

/**
 * The set of (type → payload Schema) for CURRENT_VERSION.
 * AppendEvent uses this to validate. Adding an event type = adding
 * a row here + an entry in the union below.
 *
 * Typed as `Schema<any, any, never>` because the value type differs
 * per row. Callers should `decodeUnknownEither` and pattern-match.
 */
export const PAYLOAD_SCHEMAS_V1: Readonly<Record<string, Schema.Schema<any, any, never>>> = {
  project_created: ProjectCreatedPayload,
  session_created: SessionCreatedPayload,
  session_paused: SessionPausedPayload,
  session_closed: SessionClosedPayload,
  snapshot_created: SnapshotCreatedPayload,
  observation_recorded: ObservationRecordedPayload,
  finding_created: FindingCreatedPayload,
  hypothesis_created: HypothesisCreatedPayload,
  hypothesis_weakened: HypothesisWeakenedPayload,
  hypothesis_rejected: HypothesisRejectedPayload,
  hypothesis_promoted: HypothesisPromotedPayload,
  theory_created: TheoryCreatedPayload,
  theory_updated: TheoryUpdatedPayload,
  theory_merged: TheoryMergedPayload,
  theory_archived: TheoryArchivedPayload,
  experiment_created: ExperimentCreatedPayload,
  experiment_completed: ExperimentCompletedPayload,
  decision_proposed: DecisionProposedPayload,
  decision_accepted: DecisionAcceptedPayload,
  decision_rejected: DecisionRejectedPayload,
  decision_superseded: DecisionSupersededPayload,
  conclusion_proposed: ConclusionProposedPayload,
  conclusion_verified: ConclusionVerifiedPayload,
  conclusion_rejected: ConclusionRejectedPayload,
  verification_started: VerificationStartedPayload,
  verification_passed: VerificationPassedPayload,
  verification_failed: VerificationFailedPayload,
  verification_errored: VerificationErroredPayload,
  verification_cancelled: VerificationCancelledPayload,
  verification_rerun: VerificationRerunPayload,
  artifact_attached: ArtifactAttachedPayload,
  edge_created: EdgeCreatedPayload,
  actor_registered: ActorRegisteredPayload,
  constraint_rule_added: ConstraintRuleAddedPayload,
  constraint_rule_applied: ConstraintRuleAppliedPayload,
  redaction_applied: RedactionAppliedPayload,
} as const;

/**
 * Convenience: the same map typed as a record of Schemas.
 */
export type PayloadSchemaByType = typeof PAYLOAD_SCHEMAS_V1;
export type EventType = keyof PayloadSchemaByType;
export const EVENT_TYPES: ReadonlyArray<string> = Object.keys(PAYLOAD_SCHEMAS_V1);
