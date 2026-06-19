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

import { Schema } from "effect";
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
