/**
 * Session state shapes — the same shape the reducer produces and the
 * snapshot service writes to `state_json` of the `snapshots` table.
 *
 * Phase 2 reducer lives in `./reducer.ts`. These types are the contract
 * between the pure reducer and the DB / CLI / API layers.
 *
 * Convention: every entity state carries `id` (matches its first
 * `*_created` event id), `last_event_id` (the event that most recently
 * changed the entity), and timestamps in ISO 8601.
 *
 * State machine: hypothesis (active|weakened|rejected|promoted),
 * theory (active|merged|archived), decision (proposed|accepted|rejected|superseded),
 * conclusion (unverified|verified|rejected),
 * verification (started|passed|failed|errored|cancelled). The `state`
 * field on each holds the latest transition seen for that entity.
 */

/**
 * The minimal event shape the reducer needs. Matches the on-disk
 * `EventRow` from `@cognit/db/schema/rows` structurally — the DB layer
 * passes its row through unchanged. Defined here so `core` stays
 * dependency-free.
 */
export interface ReducerEvent {
  readonly id: string;
  readonly project_id: string;
  readonly session_id: string;
  readonly actor_id: string;
  readonly type: string;
  readonly version: string;
  readonly payload_json: string;
  readonly source_json: string | null;
  readonly artifact_refs_json: string | null;
  readonly causation_id: string | null;
  readonly correlation_id: string | null;
  readonly confidence: number | null;
  readonly parent_verification_id: string | null;
  readonly linked_hypothesis_id: string | null;
  readonly created_at: string;
}

export type HypothesisLifecycle = "active" | "weakened" | "rejected" | "promoted";
export type RejectReasonType = "evidence" | "superseded" | "constraint";
export type TheoryLifecycle = "active" | "merged" | "archived";
export type DecisionLifecycle = "proposed" | "accepted" | "rejected" | "superseded";
export type ConclusionLifecycle = "unverified" | "verified" | "rejected";
export type VerificationLifecycle = "started" | "passed" | "failed" | "errored" | "cancelled";
export type SessionLifecycle = "active" | "paused" | "closed";
export type VerificationKind = "test" | "lint" | "build" | "exec" | "typecheck";
export type ArtifactRole = "evidence" | "code" | "log" | "config";

export interface ObservationState {
  readonly id: string;
  readonly text: string;
  readonly created_at: string;
  readonly last_event_id: string;
}

export interface FindingState {
  readonly id: string;
  readonly text: string;
  readonly related_observation_ids: ReadonlyArray<string>;
  readonly created_at: string;
  readonly last_event_id: string;
}

export interface HypothesisState {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly current_state: HypothesisLifecycle;
  readonly current_confidence: number | null;
  readonly current_reason: string | null;
  readonly reason_type: RejectReasonType | null;
  readonly superseded_by_id: string | null;
  readonly promoted_to_theory_id: string | null;
  readonly belongs_to_theory_id: string | null;
  readonly created_at: string;
  readonly last_event_id: string;
  readonly last_event_at: string;
  /**
   * Phase 8 v0.2 — gravity freshness timestamp (epoch SECONDS).
   * The reducer backfills this with `created_at` in epoch seconds
   * when the hypothesis is first observed. The constraint engine
   * (phase 8g.3) updates it on every mutation action. Pure
   * functions read it through `state.hypotheses` and the gravity
   * scorer turns it into a half-life decay value.
   *
   * Sentinel `0` means "never fired" — the scorer treats this as
   * stale (freshness = 0) so legacy v0.1 hypotheses do not
   * over-rank before the column is backfilled.
   */
  readonly gravity_fired_at: number;
}

export interface TheoryState {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly hypothesis_ids: ReadonlyArray<string>;
  readonly merged_into_theory_id: string | null;
  readonly archived: boolean;
  readonly created_at: string;
  readonly last_event_id: string;
  readonly last_event_at: string;
}

export interface ExperimentState {
  readonly id: string;
  readonly design: string;
  readonly tests_hypothesis_id: string;
  readonly completed: boolean;
  readonly result_summary: string | null;
  readonly supports: ReadonlyArray<string>;
  readonly contradicts: ReadonlyArray<string>;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly last_event_id: string;
}

export interface DecisionState {
  readonly id: string;
  readonly text: string;
  readonly state: DecisionLifecycle;
  readonly based_on_conclusion_ids: ReadonlyArray<string>;
  readonly reason: string | null;
  readonly superseded_by_decision_id: string | null;
  readonly created_at: string;
  readonly last_event_id: string;
  readonly last_event_at: string;
}

export interface ConclusionState {
  readonly id: string;
  readonly text: string;
  readonly state: ConclusionLifecycle;
  readonly verification_id: string | null;
  readonly supporting_evidence_ids: ReadonlyArray<string>;
  readonly reason: string | null;
  readonly created_at: string;
  readonly last_event_id: string;
  readonly last_event_at: string;
}

export interface VerificationState {
  readonly id: string;
  readonly command: string;
  readonly type: VerificationKind;
  readonly linked_hypothesis_id: string | null;
  readonly state: VerificationLifecycle;
  readonly stderr_excerpt: string | null;
  readonly error: string | null;
  readonly parent_verification_id: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  /**
   * v1.1.0 outcome fields. Populated by the reducer from the
   * matching `verification_passed` / `verification_failed` /
   * `verification_errored` / `verification_cancelled` event payload.
   * All nullable on legacy v1.0.0 verifications.
   */
  readonly expected_duration_ms: number | null;
  readonly duration_ms: number | null;
  readonly exit_code: number | null;
  readonly stdout_excerpt: string | null;
  readonly created_artifact_id: string | null;
  readonly last_event_id: string;
}

export interface ArtifactState {
  readonly id: string;
  readonly path: string;
  readonly kind: string;
  readonly role: ArtifactRole;
  readonly sha256: string | null;
  readonly size_bytes: number | null;
  readonly archived: boolean;
  readonly created_at: string;
  readonly last_event_id: string;
}

export interface EdgeState {
  readonly id: string;
  readonly edge_type: string;
  readonly from_entity_type: string;
  readonly from_entity_id: string;
  readonly to_entity_type: string;
  readonly to_entity_id: string;
  readonly created_at: string;
}

/**
 * The full derived state of a single session. This is what the reducer
 * produces and what the snapshot service writes to `state_json`.
 *
 * `current_*` fields are session-scoped pointers used by state-machine
 * events that do not carry an entity id in their payload (e.g.
 * `hypothesis_weakened` applies to the most recently created hypothesis
 * in the session). See `./reducer.ts` for the resolution rules.
 */
export interface SessionState {
  readonly session_id: string;
  readonly project_id: string;
  readonly goal: string;
  readonly parent_session_id: string | null;
  readonly status: SessionLifecycle;

  readonly current_hypothesis_id: string | null;
  readonly current_theory_id: string | null;
  readonly current_decision_id: string | null;
  readonly current_conclusion_id: string | null;
  readonly current_verification_id: string | null;

  readonly observations: ReadonlyArray<ObservationState>;
  readonly findings: ReadonlyArray<FindingState>;
  readonly hypotheses: ReadonlyMap<string, HypothesisState>;
  readonly theories: ReadonlyMap<string, TheoryState>;
  readonly experiments: ReadonlyMap<string, ExperimentState>;
  readonly decisions: ReadonlyMap<string, DecisionState>;
  readonly conclusions: ReadonlyMap<string, ConclusionState>;
  readonly verifications: ReadonlyMap<string, VerificationState>;
  readonly artifacts: ReadonlyMap<string, ArtifactState>;
  readonly edges: ReadonlyArray<EdgeState>;

  readonly timeline: ReadonlyArray<ReducerEvent>;

  readonly snapshot_event_id: string | null;
  readonly last_event_id: string | null;
  readonly last_event_at: string | null;
}

/**
 * Build an empty SessionState for a brand-new session. Used by the
 * reducer when no snapshot exists and the first event is a state event
 * other than `session_created` (e.g. resume from a half-applied log).
 */
export const emptySessionState = (params: {
  readonly session_id: string;
  readonly project_id: string;
  readonly goal: string;
  readonly parent_session_id?: string | null;
}): SessionState => ({
  session_id: params.session_id,
  project_id: params.project_id,
  goal: params.goal,
  parent_session_id: params.parent_session_id ?? null,
  status: "active",
  current_hypothesis_id: null,
  current_theory_id: null,
  current_decision_id: null,
  current_conclusion_id: null,
  current_verification_id: null,
  observations: [],
  findings: [],
  hypotheses: new Map(),
  theories: new Map(),
  experiments: new Map(),
  decisions: new Map(),
  conclusions: new Map(),
  verifications: new Map(),
  artifacts: new Map(),
  edges: [],
  timeline: [],
  snapshot_event_id: null,
  last_event_id: null,
  last_event_at: null,
});
