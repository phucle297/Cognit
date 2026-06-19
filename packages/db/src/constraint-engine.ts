/**
 * Constraint engine — pure evaluation of typed rules against a
 * SessionState + a candidate event.
 *
 * Phase 3c introduces the v1 closed predicate set (see
 * `@cognit/core/constraint-dsl`). The engine itself is a pure
 * function: it has no I/O, no DB access, no clock. The public
 * chokepoint (`SessionService.appendEvent`) calls `evalRules` between
 * the `SessionClosed` pre-check and the `EventStore.append` call.
 *
 * On match, the rule's `action` is consulted. v1 ships ONE action
 * (`block`); the rule id is added to `matchedRuleIds` regardless so
 * the chokepoint can emit `constraint_rule_applied` audit events.
 *
 * Side effect: the engine returns a `ConstraintViolation` (with rule
 * id + reason) instead of an `Either`, so the chokepoint can surface
 * it as a typed error to the caller (CLI / 3d route / inbox watcher).
 */

import { Effect, Schema } from "effect";
import { Predicate, type Action, type Predicate as PredicateT, type RuleSpec } from "@cognit/core";
import type { SessionState } from "@cognit/core";

/**
 * The candidate event the engine evaluates against. This is the
 * shape `SessionService.appendEvent` constructs from the inbound
 * `AppendEventInput`; the engine never sees the inbound shape
 * directly so it can be unit-tested without the chokepoint.
 */
export interface CandidateEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The actor's trust score; defaults to 1.0 when unknown. */
  readonly actorTrustScore: number;
  /** Pre-event count (i.e., number of events already on the log). */
  readonly sessionEventCount: number;
}

export interface EngineRule {
  readonly rule_id: string;
  readonly when: PredicateT;
  readonly then: Action;
  readonly reason: string;
}

export interface EvalResult {
  /** When false, at least one rule matched with action=block. */
  readonly allow: boolean;
  /** Rule ids that matched (regardless of action). */
  readonly matchedRuleIds: ReadonlyArray<string>;
  /** When `allow=false`, the FIRST matching rule (deterministic order). */
  readonly violation?: { readonly ruleId: string; readonly reason: string };
}

/**
 * Decode a wire-form `condition_json` into a Predicate. Throws on
 * malformed input. The CLI uses this to validate `--json` before
 * writing the rule event.
 */
export function decodePredicate(conditionJson: string): PredicateT {
  return Schema.decodeUnknownSync(Predicate)(JSON.parse(conditionJson));
}

/**
 * Validate a rule spec. Returns the canonicalised EngineRule.
 * The action is preserved as-supplied; the engine treats any non-block
 * kind as "match but don't block" (mutation actions are dispatched
 * post-append in 8g.3).
 */
export function compileRule(spec: RuleSpec, fallbackId: string): EngineRule {
  const rule_id = !spec.rule_id || spec.rule_id.length === 0 ? fallbackId : spec.rule_id;
  return { rule_id, when: spec.when, then: spec.then, reason: spec.reason };
}

/**
 * Evaluate a single predicate against (state, candidate). The 13
 * cases are spelled out explicitly so a future closed-version bump
 * reads as a single file. Each branch is a pure data check; no
 * side effects.
 */
function evaluatePredicate(
  p: PredicateT,
  state: SessionState,
  ev: CandidateEvent,
): boolean {
  switch (p.kind) {
    case "event.type":
      return ev.type === p.equals;

    case "event.payload.equals": {
      const v = ev.payload[p.field];
      return v === p.value;
    }

    case "event.payload.not_equals": {
      const v = ev.payload[p.field];
      return v !== p.value;
    }

    case "actor.trust_score_gte":
      return ev.actorTrustScore >= p.value;

    case "actor.trust_score_lt":
      return ev.actorTrustScore < p.value;

    case "state.open_hypotheses.length_gt": {
      let open = 0;
      for (const h of state.hypotheses.values()) {
        if (h.current_state === "active") open += 1;
      }
      return open > p.value;
    }

    case "state.open_verifications.length_eq": {
      let open = 0;
      for (const v of state.verifications.values()) {
        if (v.state === "started") open += 1;
      }
      return open === p.value;
    }

    case "state.last_verification.status": {
      // Find the most-recently-started verification.
      let last: { state: string } | null = null;
      let lastStarted = "";
      for (const v of state.verifications.values()) {
        if (v.started_at >= lastStarted) {
          lastStarted = v.started_at;
          last = v;
        }
      }
      if (!last) return p.equals === "none";
      return last.state === p.equals;
    }

    case "state.accepted_decisions.count_gte": {
      let n = 0;
      for (const d of state.decisions.values()) {
        if (d.state === "accepted") n += 1;
      }
      return n >= p.value;
    }

    case "session.event_count_gt":
      return ev.sessionEventCount > p.value;

    case "state.entity_field_equals": {
      const m = state[p.entity] as unknown as ReadonlyMap<string, Record<string, unknown>>;
      if (!m) return false;
      const row = m.get(p.id) as Record<string, unknown> | undefined;
      if (!row) return false;
      return row[p.field] === p.value;
    }

    case "state.edges.exists":
      return state.edges.some(
        (e) =>
          e.from_entity_id === p.fromId &&
          e.to_entity_id === p.toId &&
          e.edge_type === p.edgeType,
      );

    case "state.recent_event_types.contains": {
      const window = p.windowSize ?? 50;
      const recent = state.timeline.slice(-window);
      return recent.some((e) => e.type === p.eventType);
    }
  }
}

/**
 * Evaluate all rules in declaration order. First match with action
 * `block` triggers a violation; the function returns a typed result
 * the chokepoint can convert to `ConstraintViolation` (chokepoint) or
 * `appliedRuleIds` (audit).
 */
export function evalRules(
  rules: ReadonlyArray<EngineRule>,
  state: SessionState,
  ev: CandidateEvent,
): EvalResult {
  const matched: string[] = [];
  for (const r of rules) {
    if (evaluatePredicate(r.when, state, ev)) {
      matched.push(r.rule_id);
      if (r.then.kind === "block") {
        return {
          allow: false,
          matchedRuleIds: matched,
          violation: { ruleId: r.rule_id, reason: r.reason },
        };
      }
    }
  }
  return { allow: true, matchedRuleIds: matched };
}

// ---------------------------------------------------------------------------
// Post-append transformer (Cognit-8g.3)
// ---------------------------------------------------------------------------

/**
 * The set of event types the post-append transformer fires on. Any
 * event NOT in this set is skipped entirely — the v1 block-only path
 * (`evalBlockRules`, the audit `constraint_rule_applied` emission) is
 * the only chokepoint for every other event type, and that path is
 * untouched.
 */
export const TRANSFORM_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  "experiment_completed",
  "verification_failed",
]);

/**
 * The 4 v2 mutation action kinds — these are the ONLY actions whose
 * `then.kind` value is treated by the transformer. A `block` action
 * in a rule that matches a transform-trigger event would be a v1
 * legacy path (it never reaches the transformer because `evalRules`
 * already returned a violation pre-append). Any unknown kind is
 * silently skipped — the closed union guarantees this branch is
 * unreachable in practice, but the runtime check keeps the
 * transformer forward-compatible with future action additions.
 */
export type TransformActionKind =
  | "reject_hypothesis"
  | "weaken_hypothesis"
  | "promote_hypothesis"
  | "create_finding";

export const TRANSFORM_ACTION_KINDS: ReadonlySet<string> = new Set<TransformActionKind>([
  "reject_hypothesis",
  "weaken_hypothesis",
  "promote_hypothesis",
  "create_finding",
]);

/**
 * The dedup handle the transformer queries + writes. The shape is
 * minimal so a test fixture can supply an in-memory map; the live
 * `SessionService` wires the real SQLite-backed implementation.
 *
 * `insertIfNew` MUST be idempotent — same triple on a second call
 * returns `false` without mutating anything. The live impl uses
 * `INSERT OR IGNORE INTO constraint_action_log` and reads the
 * `changes()` count to detect duplicate.
 */
export interface ConstraintActionDedup {
  readonly insertIfNew: (key: {
    readonly eventId: string;
    readonly ruleId: string;
    readonly actionType: string;
    readonly firedAt: number;
  }) => boolean;
}

/**
 * Factory for fresh ULIDs. The transformer uses this when an
 * emitted payload requires a server-side synthesised id (the
 * `promote_hypothesis` action has no `promoted_to_theory_id` in
 * the v2 engine shape, so the transformer synthesises one). Tests
 * inject a counter-based factory; the live `SessionService`
 * injects the standard `Uuid.make` (synchronously via
 * `Effect.runSync` — `Uuid.make` is `Effect.sync` under the hood
 * so this never throws).
 */
export type UuidFactory = () => string;

/**
 * The emit callback the transformer uses to append a new event to
 * the session. The transformer fires ONE canonical event per
 * fired action; `emit` is responsible for the actual INSERT (and
 * the recursive `appendEvent` chokepoint path it triggers).
 *
 * `emit` MUST attach the event id it created to the returned row so
 * the caller can correlate. The transformer does NOT depend on the
 * returned event for dedup (the trigger `event_id` is the canonical
 * triple key) — but downstream consumers may want to inspect the
 * emitted row.
 */
export type EmitConstraintEvent = (input: {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}) => Effect.Effect<unknown, never>;

/**
 * The constraint engine's canonical actor id for emitted mutation
 * events. Every fired action stamps this on the new event row so
 * downstream consumers can attribute the mutation to the engine
 * rather than to a user / worker.
 */
export const CONSTRAINT_ENGINE_ACTOR_NAME = "system:constraint-engine" as const;

/**
 * Loop guard: skip any event whose payload carries
 * `__constraint_emitted === true`. These events are emitted by the
 * transformer itself; without this check, a rule whose predicate
 * matched `hypothesis_rejected` (etc.) would re-fire on every
 * emitted event and recurse forever. The dedup table also guards
 * this — but the payload check is faster and reads the intent
 * directly from the event itself.
 */
const isConstraintEmitted = (
  payload: Readonly<Record<string, unknown>> | undefined,
): boolean => {
  if (!payload) return false;
  const v = payload["__constraint_emitted"];
  return v === true;
};

/**
 * Build the canonical payload for an emitted mutation event.
 *
 * Every fired action emits an event with:
 *   - `rule_id`              — the rule that fired
 *   - `cause_event_id`       — the original trigger event id
 *   - `__constraint_emitted` — `true` (loop-guard flag)
 *   - action-specific fields (see below)
 *
 * Action-specific payload fields:
 *   reject_hypothesis  → { reason, reason_type, hypothesis_id }
 *   weaken_hypothesis  → { reason, hypothesis_id }
 *   promote_hypothesis → { promoted_to_theory_id, hypothesis_id }
 *   create_finding     → { text, related_observation_ids? }
 *
 * The `hypothesis_id` for the 3 hypothesis-mutating actions is
 * resolved from `state.current_hypothesis_id`. If the pointer is
 * `null` (no active hypothesis at the moment the trigger fired),
 * the mutation is a no-op — the dedup row is still inserted so a
 * stale state does not cause re-firing, and the transformer skips
 * emission. AC-8.11 requires the engine to emit exactly one
 * canonical event per fired action; emitting a hypothesis mutation
 * without a hypothesis would force the reducer to drop it, so we
 * skip cleanly here.
 */
const buildActionPayload = (
  action: Action,
  causeEventId: string,
  ruleId: string,
  ruleReason: string,
  resolved: {
    readonly currentHypothesisId: string | null;
    readonly synthesizeId: () => string;
  },
): Record<string, unknown> | null => {
  const base = {
    rule_id: ruleId,
    cause_event_id: causeEventId,
    __constraint_emitted: true,
  } as Record<string, unknown>;
  switch (action.kind) {
    case "block":
      // Block actions are not handled by the transformer — this
      // branch is unreachable because `evalRules` already short-
      // circuited pre-append. Return null defensively.
      return null;
    case "reject_hypothesis": {
      if (resolved.currentHypothesisId === null) return null;
      return {
        ...base,
        reason_type: action.reason_type,
        superseded_by_id: null,
        hypothesis_id: resolved.currentHypothesisId,
        reason: action.reason,
      };
    }
    case "weaken_hypothesis": {
      if (resolved.currentHypothesisId === null) return null;
      // The v2 engine shape (`@cognit/core/constraint-dsl.ts:188`)
      // for `weaken_hypothesis` has NO `reason` field — the v1
      // wire schema for `hypothesis_weakened` requires a non-empty
      // `reason` string. We carry the RULE's `reason` text as the
      // emitted reason so the reducer gets a stable, auditable
      // explanation without forcing a DSL extension. (A future
      // follow-up could add `reason` to the DSL action if per-fire
      // reasons are needed.)
      return {
        ...base,
        reason: ruleReason,
        hypothesis_id: resolved.currentHypothesisId,
      };
    }
    case "promote_hypothesis": {
      if (resolved.currentHypothesisId === null) return null;
      // The v2 engine shape (`@cognit/core/constraint-dsl.ts:192`)
      // does NOT carry a `promoted_to_theory_id` — the v1 wire
      // schema for `hypothesis_promoted` requires a non-null
      // string id (`HypothesisPromotedPayload.promoted_to_theory_id`).
      // The transformer synthesises a fresh id at fire time; the
      // reducer stores it on the hypothesis row. A follow-up bead
      // will pair `promote_hypothesis` with a `theory_created`
      // emission to materialise the theory itself.
      return {
        ...base,
        promoted_to_theory_id: resolved.synthesizeId(),
        hypothesis_id: resolved.currentHypothesisId,
      };
    }
    case "create_finding": {
      // create_finding does not require a hypothesis. Always
      // returns a payload.
      return {
        ...base,
        text: action.text,
      };
    }
  }
};

/**
 * Resolve the canonical event type for a fired mutation action.
 * The engine's Action.kind string matches the wire event type by
 * design (see `@cognit/core/constraint-dsl.ts:182-199` and the
 * reducer branches at `reducer.ts:268/293/317` and 219). Keeping
 * the mapping explicit here so a future rename in either layer
 * surfaces as a single-file edit.
 */
const actionKindToEventType = (kind: TransformActionKind): string => {
  switch (kind) {
    case "reject_hypothesis":
      return "hypothesis_rejected";
    case "weaken_hypothesis":
      return "hypothesis_weakened";
    case "promote_hypothesis":
      return "hypothesis_promoted";
    case "create_finding":
      return "finding_created";
  }
};

/**
 * Evaluate the post-append transformer on a freshly-inserted event.
 *
 * This function is PURE with respect to its inputs — it does not
 * query the DB. The DB-facing concerns (dedup INSERT OR IGNORE,
 * recursive appendEvent for emitted events) are delegated to the
 * injected `dedup` + `emit` callbacks. The live `SessionService`
 * builds those from the open `DbConnection` and the `SessionService`
 * reference respectively.
 *
 * Loop guard: three layers — (1) skip-constraint-emitted payload
 * flag; (2) trigger-type allow-list (`TRANSFORM_TRIGGER_TYPES`); (3)
 * `(event_id, rule_id, action_type)` dedup table.
 *
 * Iteration order: rules are walked in declaration order, matching
 * `evalRules`. Each rule's predicate is evaluated against the
 * FRESH post-append state (`state` — the caller folds the trigger
 * event into `state` before calling this function). When a rule's
 * predicate matches AND its action is a transform-action AND the
 * dedup triple is new, the transformer calls `emit` ONCE and
 * records the dedup row. Multiple rules matching the same trigger
 * each emit their own canonical event (N rules = N emits for the
 * same `event_id`); the dedup triple differs in `rule_id` so they
 * do not collide.
 *
 * Returns the list of emitted events (one per fired action).
 */
export function evalTransformRules(
  insertedEvent: { readonly id: string; readonly type: string; readonly payload: Readonly<Record<string, unknown>> },
  state: SessionState,
  rules: ReadonlyArray<EngineRule>,
  dedup: ConstraintActionDedup,
  emit: EmitConstraintEvent,
  uuidFactory: UuidFactory,
): Effect.Effect<ReadonlyArray<unknown>, never> {
  return Effect.gen(function* () {
    // Loop guard #1: skip events emitted by the constraint engine
    // itself. Documented in bead Cognit-8g.3 AC-8.10.
    if (isConstraintEmitted(insertedEvent.payload)) {
      return [] as ReadonlyArray<unknown>;
    }
    // Loop guard #2: trigger-type allow-list. Anything outside
    // {experiment_completed, verification_failed} is not a
    // post-append transform trigger — the v1 audit + block paths
    // handle every other event type.
    if (!TRANSFORM_TRIGGER_TYPES.has(insertedEvent.type)) {
      return [] as ReadonlyArray<unknown>;
    }

    const firedAt = Date.now() / 1000;
    const emitted: unknown[] = [];
    const currentHypothesisId = state.current_hypothesis_id;

    for (const rule of rules) {
      const candidate: CandidateEvent = {
        type: insertedEvent.type,
        payload: insertedEvent.payload,
        actorTrustScore: 1.0,
        sessionEventCount: state.timeline.length,
      };
      if (!evaluatePredicate(rule.when, state, candidate)) continue;
      // Only mutation actions are dispatched post-append. A block
      // action that matched here would be a v1 path bug — `evalRules`
      // already returned a violation pre-append and the trigger
      // event would not have been inserted. Skip silently.
      const actionKind = rule.then.kind;
      if (!TRANSFORM_ACTION_KINDS.has(actionKind)) continue;

      const dedupKey = {
        eventId: insertedEvent.id,
        ruleId: rule.rule_id,
        actionType: actionKind,
        firedAt,
      };
      const isNew = dedup.insertIfNew(dedupKey);
      if (!isNew) continue;

      const payload = buildActionPayload(rule.then, insertedEvent.id, rule.rule_id, rule.reason, {
        currentHypothesisId,
        synthesizeId: uuidFactory,
      });
      if (payload === null) continue;

      const eventType = actionKindToEventType(actionKind as TransformActionKind);
      const row = yield* emit({ type: eventType, payload });
      emitted.push(row);
    }
    return emitted;
  });
}
