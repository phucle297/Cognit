import { Schema } from "effect";

/**
 * Current payload schema version. Append always writes this version.
 * On read, `migrate(eventRow, row.version, CURRENT_VERSION)` brings old
 * events up to current. Migrations are pure, additive, and tested.
 */
export const CURRENT_VERSION = "1.1.0" as const;

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

/**
 * v1.1.0 verification payload schemas — extend v1.0.0 with the
 * outcome fields recorded by the subprocess engine (Phase 4 / 4a).
 * All new fields are optional with `null` defaults so v1.0.0 events
 * decode against v1.1.0 without a transform.
 */
const VerificationStartedPayloadV1_1 = Schema.Struct({
  command: Schema.String,
  type: Schema.Literal("test", "lint", "build", "exec", "typecheck"),
  linked_hypothesis_id: Schema.NullOr(Schema.String),
  expected_duration_ms: Schema.optionalWith(Schema.NullOr(Schema.Number), {
    default: () => null,
  }),
});
const VerificationPassedPayloadV1_1 = Schema.Struct({
  exit_code: Schema.optionalWith(Schema.Number.pipe(Schema.int()), {
    default: () => 0,
  }),
  duration_ms: Schema.optionalWith(Schema.NullOr(Schema.Number.pipe(Schema.int())), {
    default: () => null,
  }),
  stdout_excerpt: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
  created_artifact_id: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
});
const VerificationFailedPayloadV1_1 = Schema.Struct({
  stderr_excerpt: Schema.String,
  exit_code: Schema.optionalWith(Schema.NullOr(Schema.Number.pipe(Schema.int())), {
    default: () => null,
  }),
  duration_ms: Schema.optionalWith(Schema.NullOr(Schema.Number.pipe(Schema.int())), {
    default: () => null,
  }),
  stdout_excerpt: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
  created_artifact_id: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
});
const VerificationErroredPayloadV1_1 = Schema.Struct({
  error: Schema.String,
  duration_ms: Schema.optionalWith(Schema.NullOr(Schema.Number.pipe(Schema.int())), {
    default: () => null,
  }),
});
const VerificationCancelledPayloadV1_1 = Schema.Struct({
  reason: Schema.String,
  duration_ms: Schema.optionalWith(Schema.NullOr(Schema.Number.pipe(Schema.int())), {
    default: () => null,
  }),
});
const VerificationRerunPayloadV1_1 = Schema.Struct({
  parent_verification_id: Schema.String,
  duration_ms: Schema.optionalWith(Schema.NullOr(Schema.Number.pipe(Schema.int())), {
    default: () => null,
  }),
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
  reason: Schema.String,
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
 * The set of (type → payload Schema) for v1.0.0.
 *
 * `PAYLOAD_SCHEMAS_V1` is preserved as the v1.0.0 strict map so
 * historical event rows read back through the v1.0.0 schema (the
 * migration runner and the "schema for v1.0.0 is strict" test both
 * depend on this name). New writes go through v1.1.0 (see below).
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
 * The set of (type → payload Schema) for v1.1.0. The current version
 * of the wire format. Only verification_* payloads changed in this
 * version; all others are shared with v1.0.0 (referenced by alias).
 */
export const PAYLOAD_SCHEMAS_V1_1_0: Readonly<Record<string, Schema.Schema<any, any, never>>> = {
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
  verification_started: VerificationStartedPayloadV1_1,
  verification_passed: VerificationPassedPayloadV1_1,
  verification_failed: VerificationFailedPayloadV1_1,
  verification_errored: VerificationErroredPayloadV1_1,
  verification_cancelled: VerificationCancelledPayloadV1_1,
  verification_rerun: VerificationRerunPayloadV1_1,
  artifact_attached: ArtifactAttachedPayload,
  edge_created: EdgeCreatedPayload,
  actor_registered: ActorRegisteredPayload,
  constraint_rule_added: ConstraintRuleAddedPayload,
  constraint_rule_applied: ConstraintRuleAppliedPayload,
  redaction_applied: RedactionAppliedPayload,
} as const;

/**
 * Schema map keyed by payload version. The migration runner uses this
 * to pick the right schema for the `to` version. Unlisted versions
 * fall back to v1.0.0 strict schemas (defensive default — unknown
 * versions should fail loudly at the schema-validation step).
 */
export const PAYLOAD_SCHEMAS_BY_VERSION: Readonly<
  Record<string, Readonly<Record<string, Schema.Schema<any, any, never>>>>
> = {
  "1.0.0": PAYLOAD_SCHEMAS_V1,
  "1.1.0": PAYLOAD_SCHEMAS_V1_1_0,
};

/**
 * Convenience: the same map typed as a record of Schemas.
 */
export type PayloadSchemaByType = typeof PAYLOAD_SCHEMAS_V1_1_0;
export type EventType = keyof PayloadSchemaByType;
export const EVENT_TYPES: ReadonlyArray<string> = Object.keys(PAYLOAD_SCHEMAS_V1_1_0);
