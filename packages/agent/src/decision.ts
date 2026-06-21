/**
 * packages/agent/src/decision.ts — AgentDecision schema (C2).
 *
 * The shape the LLM is asked to emit each tick. Validated with an
 * Effect Schema so the supervisor loop can trust the parse step
 * before invoking the EventStore append chokepoint.
 *
 * `schema_version` lets future schema bumps live alongside v1
 * without breaking on-the-wire compatibility — the loop pins the
 * version it knows how to apply and rejects unknown versions before
 * touching the event store.
 *
 * Actions cover the levers the supervisor can pull:
 *   - weaken / reject / promote a hypothesis
 *   - propose a decision (recorded as a DecisionState)
 *   - request a verification (kicks off the subprocess engine)
 *
 * `rank_overrides` are the AI-driven gravity rank events (v1.2.0
 * `hypothesis_ranked`). They are *separate* from the action list
 * because the reducer treats them as additive: every override emits
 * a `hypothesis_ranked` event whether or not the action list also
 * touches that hypothesis. The cap (see `apply.ts`) is applied to the
 * action list only — rank overrides are cheap and idempotent.
 *
 * `stop` signals the supervisor to idle this session — the loop
 * returns without scheduling another tick. The CLI / dashboard
 * surfaces this on the agent status endpoint.
 */

import { Schema } from "effect";

/**
 * A supervisor action. Tagged union so the LLM must emit exactly one
 * `kind` per action (no fields bleed between variants). Each variant
 * matches an event payload schema in `@cognit/db/event-schema` — the
 * `apply.ts` translator maps each variant to the matching `append`
 * call without re-validation (the EventStore append chokepoint does
 * that).
 */
export const AgentAction = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("weaken_hypothesis"),
    hypothesis_id: Schema.String.pipe(Schema.minLength(1)),
    reason: Schema.String.pipe(Schema.minLength(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal("reject_hypothesis"),
    hypothesis_id: Schema.String.pipe(Schema.minLength(1)),
    reason_type: Schema.Literal("evidence", "superseded", "constraint"),
    superseded_by_id: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("promote_hypothesis"),
    hypothesis_id: Schema.String.pipe(Schema.minLength(1)),
    promoted_to_theory_id: Schema.String.pipe(Schema.minLength(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal("propose_decision"),
    text: Schema.String.pipe(Schema.minLength(1)),
    based_on_conclusion_ids: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("request_verification"),
    command: Schema.String.pipe(Schema.minLength(1)),
    type: Schema.Literal("test", "lint", "build", "exec", "typecheck"),
    linked_hypothesis_id: Schema.optional(Schema.NullOr(Schema.String)),
    expected_duration_ms: Schema.optional(Schema.NullOr(Schema.Number.pipe(Schema.int()))),
  }),
);
export type AgentAction = Schema.Schema.Type<typeof AgentAction>;

/**
 * AI-driven gravity rank override. Mirrors the v1.2.0
 * `hypothesis_ranked` payload schema. The loop emits one
 * `hypothesis_ranked` event per override (the reducer stores the
 * latest one on `HypothesisState.ai_rank_*`).
 */
export const RankOverride = Schema.Struct({
  hypothesis_id: Schema.String.pipe(Schema.minLength(1)),
  score: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(1)),
  reasoning: Schema.String.pipe(Schema.minLength(1)),
});
export type RankOverride = Schema.Schema.Type<typeof RankOverride>;

/**
 * Top-level decision shape the LLM emits. The `schema_version`
 * literal pins the contract — future bumps declare a new value and
 * the loop refuses unknown versions (defensive: a model that drifts
 * to a newer schema mid-stream should not silently start writing
 * rows the current apply.ts does not understand).
 */
export const AgentDecision = Schema.Struct({
  schema_version: Schema.Literal("1"),
  rationale: Schema.String.pipe(Schema.minLength(1)),
  actions: Schema.Array(AgentAction),
  rank_overrides: Schema.optionalWith(Schema.Array(RankOverride), {
    default: () => [] as ReadonlyArray<RankOverride>,
  }),
  stop: Schema.Boolean,
});
export type AgentDecision = Schema.Schema.Type<typeof AgentDecision>;

/**
 * Convenience codec so callers can do
 * `decodeAgentDecisionEither(rawJson)` without re-importing the Schema.
 */
export const decodeAgentDecisionEither = (
  value: unknown,
): import("effect").Either.Either<AgentDecision, unknown> =>
  Schema.decodeUnknownEither(AgentDecision)(value);

/**
 * Encode an AgentDecision to a plain JSON-serialisable object. The
 * prompt builder asks the LLM for *exactly* this shape; we provide it
 * for symmetry with the codec.
 */
export const encodeAgentDecision = (decision: AgentDecision): unknown =>
  Schema.encodeUnknownSync(AgentDecision)(decision);
