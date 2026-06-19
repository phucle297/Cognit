/**
 * Constraint DSL — closed v1 predicate vocabulary.
 *
 * The constraint engine evaluates typed rules of the shape
 * `{ when: Predicate, then: Action, reason: string }` against the
 * `SessionState` + a candidate event. Phase 3c ships a CLOSED v1 set
 * of 13 predicates; new predicates are added via a core schema version
 * bump (the same convention as `PAYLOAD_SCHEMAS_V1` / `CURRENT_VERSION`).
 *
 * Why closed? The alternative is a user-extensible predicate language,
 * which is a footgun (untyped eval, surprise perf, surprise semantics).
 * The project's "extend via schema version" convention is the right
 * way to add new predicates.
 *
 * v1 set (13 predicates, extended from the original 10 after phase
 * 3.0 adversarial review found 3 lifecycle rules unexpressible):
 *
 * Event-shape (3):
 *   1.  event.type ==
 *   2.  event.payload.<field> ==
 *   3.  event.payload.<field> !=
 *
 * Actor-shape (2):
 *   4.  actor.trust_score >=
 *   5.  actor.trust_score <
 *
 * State-shape (5):
 *   6.  state.open_hypotheses.length >
 *   7.  state.open_verifications.length ==
 *   8.  state.last_verification.status ==
 *   9.  state.accepted_decisions.count >=
 *  10.  state.session.event_count >
 *
 * Existence / membership (3):
 *  11.  state.<entity_map>[id].<field> ==       (entity lookup)
 *  12.  state.edges.exists(from_id, to_id, type) (edge existence)
 *  13.  state.recent_event_types.contains(type) (multi-event)
 *
 * The Predicate and Action unions are typed via Effect-Schema so a
 * constraint_rule_added payload is validated on append.
 */

import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Predicate — the closed v1 set
// ---------------------------------------------------------------------------

/** 1. event.type == "<EVENT_TYPE>" */
export const EventTypeIs = Schema.Struct({
  kind: Schema.Literal("event.type"),
  equals: Schema.String,
});

/** 2. event.payload.<field> == "<value>" */
export const PayloadFieldEquals = Schema.Struct({
  kind: Schema.Literal("event.payload.equals"),
  field: Schema.String,
  value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean, Schema.Null),
});

/** 3. event.payload.<field> != "<value>" */
export const PayloadFieldNotEquals = Schema.Struct({
  kind: Schema.Literal("event.payload.not_equals"),
  field: Schema.String,
  value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean, Schema.Null),
});

/** 4. actor.trust_score >= n  (best-effort; defaults to 1.0 if unknown) */
export const ActorTrustGte = Schema.Struct({
  kind: Schema.Literal("actor.trust_score_gte"),
  value: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(1)),
});

/** 5. actor.trust_score < n */
export const ActorTrustLt = Schema.Struct({
  kind: Schema.Literal("actor.trust_score_lt"),
  value: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(1)),
});

/** 6. state.open_hypotheses.length > n (the count of hypotheses with state=active) */
export const OpenHypothesesGt = Schema.Struct({
  kind: Schema.Literal("state.open_hypotheses.length_gt"),
  value: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0)),
});

/** 7. state.open_verifications.length == n */
export const OpenVerificationsEq = Schema.Struct({
  kind: Schema.Literal("state.open_verifications.length_eq"),
  value: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0)),
});

/** 8. state.last_verification.status == "<status>" */
export const LastVerificationStatusIs = Schema.Struct({
  kind: Schema.Literal("state.last_verification.status"),
  equals: Schema.Literal("pending", "passed", "failed", "errored", "cancelled", "none"),
});

/** 9. state.accepted_decisions.count >= n */
export const AcceptedDecisionsGte = Schema.Struct({
  kind: Schema.Literal("state.accepted_decisions.count_gte"),
  value: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0)),
});

/** 10. session.event_count > n (count of events already applied) */
export const SessionEventCountGt = Schema.Struct({
  kind: Schema.Literal("session.event_count_gt"),
  value: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0)),
});

/** 11. state.<entity_map>[id].<field> == "<value>" — entity lookup */
export const EntityFieldEquals = Schema.Struct({
  kind: Schema.Literal("state.entity_field_equals"),
  entity: Schema.Literal(
    "hypotheses",
    "theories",
    "experiments",
    "decisions",
    "conclusions",
    "verifications",
    "artifacts",
  ),
  id: Schema.String,
  field: Schema.String,
  value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean, Schema.Null),
});

/** 12. state.edges.exists(from_id, to_id, type) */
export const EdgeExists = Schema.Struct({
  kind: Schema.Literal("state.edges.exists"),
  fromId: Schema.String,
  toId: Schema.String,
  edgeType: Schema.String,
});

/** 13. state.recent_event_types.contains(type) */
export const RecentEventTypesContains = Schema.Struct({
  kind: Schema.Literal("state.recent_event_types.contains"),
  eventType: Schema.String,
  windowSize: Schema.optional(Schema.Number.pipe(Schema.greaterThanOrEqualTo(1))),
});

export const Predicate = Schema.Union(
  EventTypeIs,
  PayloadFieldEquals,
  PayloadFieldNotEquals,
  ActorTrustGte,
  ActorTrustLt,
  OpenHypothesesGt,
  OpenVerificationsEq,
  LastVerificationStatusIs,
  AcceptedDecisionsGte,
  SessionEventCountGt,
  EntityFieldEquals,
  EdgeExists,
  RecentEventTypesContains,
);
export type Predicate = Schema.Schema.Type<typeof Predicate>;

export const PredicateJson = Schema.parseJson(Predicate);

// ---------------------------------------------------------------------------
// Action — what the engine does when a rule fires
// ---------------------------------------------------------------------------

/**
 * v1 ships ONE action: `block` (the engine rejects the event with a
 * `ConstraintViolation`). We may add `tag`, `redact`, etc. in later
 * versions. The action is part of the rule shape so a rule can be
 * declared "match-only" by setting action to a no-op (v2).
 */
export const BlockAction = Schema.Struct({
  kind: Schema.Literal("block"),
});

/**
 * v2 mutation actions — fired post-append on `experiment_completed`
 * and `verification_failed` events. Each emits ONE canonical event
 * with `actor_id = "system:constraint-engine"`. Schema-only here;
 * engine wiring is 8g.3.
 */
export const RejectHypothesisAction = Schema.Struct({
  kind: Schema.Literal("reject_hypothesis"),
  reason: Schema.String.pipe(Schema.minLength(1)),
  reason_type: Schema.Literal("evidence", "superseded", "constraint"),
});

export const WeakenHypothesisAction = Schema.Struct({
  kind: Schema.Literal("weaken_hypothesis"),
});

export const PromoteHypothesisAction = Schema.Struct({
  kind: Schema.Literal("promote_hypothesis"),
});

export const CreateFindingAction = Schema.Struct({
  kind: Schema.Literal("create_finding"),
  text: Schema.String.pipe(Schema.minLength(1)),
});

export const Action = Schema.Union(
  BlockAction,
  RejectHypothesisAction,
  WeakenHypothesisAction,
  PromoteHypothesisAction,
  CreateFindingAction,
);
export type Action = Schema.Schema.Type<typeof Action>;

// ---------------------------------------------------------------------------
// Rule — the full rule shape
// ---------------------------------------------------------------------------

export const Rule = Schema.Struct({
  rule_id: Schema.String.pipe(Schema.minLength(1)),
  when: Predicate,
  then: Action,
  reason: Schema.String.pipe(Schema.minLength(1)),
});
export type Rule = Schema.Schema.Type<typeof Rule>;

/**
 * Encode a rule as the wire form stored inside the
 * `constraint_rule_added` event's `condition_json` / `actions_json`
 * payload fields. Kept separate from `Rule` because the wire form is
 * an opaque JSON string (the user supplies it via `cognit constraint
 * add --json '{...}'`), and the engine decodes via `PredicateJson`.
 */
export interface RuleSpec {
  readonly when: Predicate;
  readonly then: Action;
  readonly reason: string;
  /** Optional caller-supplied id; engine generates one if absent. */
  readonly rule_id?: string;
}
