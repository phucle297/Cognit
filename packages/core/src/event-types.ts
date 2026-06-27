/**
 * Canonical event-type sets — single source of truth.
 *
 * Moved verbatim from `./reducer.ts` so the reducer (which uses them at
 * runtime to skip non-state events) and the DB schema-builder (which
 * asserts at compile time that the payload schema map covers exactly
 * this set) share one definition. The runtime `Set<string>` shapes are
 * preserved exactly so reducer behaviour is unchanged; the tuple form
 * below is the type-level projection used by
 * `packages/db/src/event-schema-keys.ts` for its compile-time assertion.
 */

/** Tuple form — drives the `StateEventType` union via `typeof[number]`. */
export const STATE_EVENT_TYPES_TUPLE = [
  "session_created",
  "session_paused",
  "session_closed",
  "observation_recorded",
  "finding_created",
  "hypothesis_created",
  "hypothesis_weakened",
  "hypothesis_rejected",
  "hypothesis_promoted",
  "theory_created",
  "theory_updated",
  "theory_merged",
  "theory_archived",
  "experiment_created",
  "experiment_completed",
  "decision_proposed",
  "decision_accepted",
  "decision_rejected",
  "decision_superseded",
  "conclusion_proposed",
  "conclusion_verified",
  "conclusion_rejected",
  "verification_started",
  "verification_passed",
  "verification_failed",
  "verification_errored",
  "verification_cancelled",
  "verification_rerun",
  "artifact_attached",
  "edge_created",
  "hypothesis_ranked",
] as const;

/** Tuple form — drives the `NonStateEventType` union via `typeof[number]`. */
export const NON_STATE_EVENT_TYPES_TUPLE = [
  "project_created",
  "actor_registered",
  "redaction_applied",
  "constraint_rule_added",
  "constraint_rule_applied",
  "snapshot_created",
] as const;

/** Union of event types the reducer actively folds into state. */
export type StateEventType = (typeof STATE_EVENT_TYPES_TUPLE)[number];

/** Union of event types appended to the timeline but not folded. */
export type NonStateEventType = (typeof NON_STATE_EVENT_TYPES_TUPLE)[number];

/** Union of every known event type in the system. */
export type KnownEventType = StateEventType | NonStateEventType;

/** Runtime set used by the reducer to detect state-folding events. */
export const STATE_EVENT_TYPES: ReadonlySet<string> = new Set<string>(STATE_EVENT_TYPES_TUPLE);

/** Runtime set used by the reducer for non-state-folding events. */
export const NON_STATE_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  NON_STATE_EVENT_TYPES_TUPLE,
);

/** Runtime set covering every known event type. */
export const ALL_KNOWN_TYPES: ReadonlySet<string> = new Set<string>([
  ...STATE_EVENT_TYPES,
  ...NON_STATE_EVENT_TYPES,
]);
