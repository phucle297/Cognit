/**
 * packages/agent/src/apply.ts — AgentDecision → EventStore.append (C2).
 *
 * Translates a parsed AgentDecision into a sequence of
 * EventStore.append calls. Idempotent: the caller passes a `tickId`
 * (ULID) and the per-action event ids are derived deterministically
 * (`tickId + "-" + index`). Re-applying the same decision produces
 * the same event ids → the append chokepoint's idempotency check
 * returns the existing row instead of double-writing.
 *
 * Action cap: the action list is truncated to
 * `cfg.max_actions_per_tick` before any append. Rank overrides are
 * *not* truncated (they are cheap, idempotent, and the whole point
 * of the AI supervisor is to produce them). The cap exists so a
 * runaway LLM cannot bulk-write the entire event stream in one tick.
 *
 * Decision-shape errors surface here, not in the LLM layer: if the
 * payload fails per-type validation (e.g. a promote_hypothesis
 * with a duplicate theory id), the EventStore append chokepoint
 * rejects it and the failure propagates. We don't pre-validate
 * because the chokepoint is the authoritative validation point
 * (single source of truth for what an event row may carry).
 */

import type { ActorType, DbError, EventStoreShape, UnknownEventType, UnknownSession, ValidationFailure } from "@cognit/db";
import { Effect } from "effect";
import type { AgentConfig } from "./agent-config.js";
import type { AgentAction, AgentDecision } from "./decision.js";

/**
 * Stable id derivation. The same tick id + action index always
 * produces the same event id, so retries are safe.
 */
export const actionEventId = (tickId: string, index: number): string =>
  `${tickId}-a${index.toString(36).padStart(4, "0")}`;

export const rankOverrideEventId = (tickId: string, hypothesisId: string): string =>
  `${tickId}-r${hypothesisId}`;

/** A single applied action's outcome. */
export interface AppliedAction {
  readonly index: number;
  readonly kind: AgentAction["kind"];
  readonly eventId: string;
  readonly type: string;
}

/** Result of applying one tick's decision. */
export interface ApplyTickResult {
  readonly tickId: string;
  readonly actions: ReadonlyArray<AppliedAction>;
  readonly rankOverrides: ReadonlyArray<{ readonly eventId: string; readonly hypothesisId: string }>;
  readonly actionsTruncated: number;
}

/**
 * Append-input shape — flattened to keep the per-case code obvious.
 * `linkedHypothesisId` is set on the row's FK column for events that
 * reference a hypothesis via that channel; the reject/weaken/promote
 * variants use the column, propose_decision leaves it null.
 */
interface AppendMapping {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly linkedHypothesisId: string | null;
}

const mapAction = (action: AgentAction, index: number, tickId: string): AppendMapping => {
  const id = actionEventId(tickId, index);
  switch (action.kind) {
    case "weaken_hypothesis":
      return {
        id,
        type: "hypothesis_weakened",
        payload: { reason: action.reason },
        linkedHypothesisId: action.hypothesis_id,
      };
    case "reject_hypothesis":
      return {
        id,
        type: "hypothesis_rejected",
        payload: {
          reason_type: action.reason_type,
          superseded_by_id: action.superseded_by_id ?? null,
        },
        linkedHypothesisId: action.hypothesis_id,
      };
    case "promote_hypothesis":
      return {
        id,
        type: "hypothesis_promoted",
        payload: { promoted_to_theory_id: action.promoted_to_theory_id },
        linkedHypothesisId: action.hypothesis_id,
      };
    case "propose_decision":
      return {
        id,
        type: "decision_proposed",
        payload: {
          text: action.text,
          based_on_conclusion_ids: action.based_on_conclusion_ids,
        },
        linkedHypothesisId: null,
      };
    case "request_verification":
      return {
        id,
        type: "verification_started",
        payload: {
          command: action.command,
          type: action.type,
          linked_hypothesis_id: action.linked_hypothesis_id ?? null,
          expected_duration_ms: action.expected_duration_ms ?? null,
        },
        linkedHypothesisId: action.linked_hypothesis_id ?? null,
      };
  }
  // Exhaustiveness guard — the switch above covers every union variant;
  // reaching here would mean a new variant was added to AgentAction
  // without updating this translator. The `_exhaustive` variable makes
  // TS error at compile time if the union grows.
  const _exhaustive: never = action;
  void _exhaustive;
  throw new Error(`unhandled action kind: ${(action as { kind: string }).kind}`);
};

/** Apply errors — the union of EventStore append error channels. */
export type ApplyError = UnknownEventType | ValidationFailure | UnknownSession | DbError;

/**
 * Apply one tick's decision. Iterates the action list (capped),
 * then the rank overrides. Each step is a separate `store.append`
 * call so per-event failures bubble up at the right granularity.
 *
 * The function does not consume the decision's `rationale` or
 * `stop` fields — the loop interprets those (rationale is logged,
 * stop terminates the supervisor for this session).
 */
export const applyDecision = (input: {
  readonly store: EventStoreShape;
  readonly decision: AgentDecision;
  readonly tickId: string;
  readonly sessionId: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly cfg: Pick<AgentConfig, "max_actions_per_tick">;
  readonly correlationId?: string | null;
}): Effect.Effect<ApplyTickResult, ApplyError> =>
  Effect.gen(function* () {
    const cap = input.cfg.max_actions_per_tick;
    const actions = input.decision.actions.slice(0, cap);
    const truncated = input.decision.actions.length - actions.length;
    const correlationId = input.correlationId ?? null;

    const appliedActions: AppliedAction[] = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      const m = mapAction(action, i, input.tickId);
      const row = yield* input.store.append({
        id: m.id,
        type: m.type,
        payload: m.payload,
        sessionId: input.sessionId,
        actor: input.actor,
        ...(m.linkedHypothesisId === null ? {} : { linkedHypothesisId: m.linkedHypothesisId }),
        ...(correlationId === null ? {} : { correlationId }),
      });
      appliedActions.push({
        index: i,
        kind: action.kind,
        eventId: row.id,
        type: row.type,
      });
    }

    const appliedRanks: Array<{ eventId: string; hypothesisId: string }> = [];
    for (const ro of input.decision.rank_overrides) {
      const id = rankOverrideEventId(input.tickId, ro.hypothesis_id);
      const row = yield* input.store.append({
        id,
        type: "hypothesis_ranked",
        payload: {
          hypothesis_id: ro.hypothesis_id,
          score: ro.score,
          reasoning: ro.reasoning,
          evaluator: "ai-supervisor",
          override_rule_based: true,
          context_event_ids: [],
        },
        sessionId: input.sessionId,
        actor: input.actor,
        ...(correlationId === null ? {} : { correlationId }),
      });
      appliedRanks.push({ eventId: row.id, hypothesisId: ro.hypothesis_id });
    }

    return {
      tickId: input.tickId,
      actions: appliedActions as ReadonlyArray<AppliedAction>,
      rankOverrides: appliedRanks as ReadonlyArray<{
        readonly eventId: string;
        readonly hypothesisId: string;
      }>,
      actionsTruncated: truncated,
    } satisfies ApplyTickResult;
  });
