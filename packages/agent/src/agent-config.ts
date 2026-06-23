/**
 * packages/agent/src/agent-config.ts — agent.* config block schema (C2).
 *
 * Standalone schema (not yet merged into CognitConfigSchema in
 * `@cognit/core`) so the agent package stays self-contained for
 * tests and CLI wiring. The CLI layer-build step is responsible for
 * reading `cognit.yaml → agent.*` and producing a Layer that satisfies
 * the `AgentConfig` tag defined here.
 *
 * `AgentProvider` is a DEPRECATED closed literal — kept for the
 * `--provider` back-compat grace period on `cognit agent run`
 * (spec §4). New commands (`cognit ask`) and the migrated supervisor
 * route through the Vercel AI Gateway via `gatewayModel(...)`, not
 * through the closed-literal switch in `@cognit/llm`. After one
 * minor release the literal is removed and the `provider` field
 * is deleted from `AgentConfig`.
 */

import { Schema } from "effect";

const PositiveInt = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0));
const NonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0));

/**
 * @deprecated Retained for `--provider` back-compat. New code must
 * use the Vercel AI Gateway model id format (`<provider>/<id>`)
 * instead — see `LlmConfig` in `@cognit/core/config`.
 *
 * Removing this literal is the second half of the migration
 * (Cognit-l06/007). Until then, every reference must include a
 * `@deprecated` JSDoc so new callers don't reach for it.
 */
export const AgentProvider = Schema.Literal("anthropic", "openai", "google", "ollama", "mock");
export type AgentProvider = Schema.Schema.Type<typeof AgentProvider>;

/**
 * Relaxed: `provider` is truly optional (no implicit `"mock"`
 * default). Callers that want the mock path now set it explicitly
 * (`{ provider: "mock", ... }`); callers migrating to the Gateway
 * leave it unset. The supervisor loop reads `provider` and passes
 * it through to the LLM layer, which is responsible for either
 * routing through `modelFor(provider, ...)` (legacy) or routing
 * through `gatewayModel(...)` (preferred, post-migration).
 */
export const AgentConfig = Schema.Struct({
  provider: Schema.optional(AgentProvider),
  model: Schema.optionalWith(Schema.String.pipe(Schema.minLength(1)), {
    default: () => "mock-1",
  }),
  /**
   * Cap on actions emitted per tick. The apply step truncates the
   * action list to this length before issuing appends. Set to 0 to
   * allow only rank_overrides + stop (useful for a "rank-only" tick).
   */
  max_actions_per_tick: Schema.optionalWith(NonNegativeInt, { default: () => 5 }),
  /**
   * Cap on hypotheses shown to the LLM per prompt. The prompt
   * builder truncates the sorted list at this length. Default 50 —
   * a large enough window to be useful on real sessions without
   * blowing the context budget of small open-source models.
   */
  max_prompt_hypotheses: Schema.optionalWith(PositiveInt, {
    default: () => DEFAULT_MAX_PROMPT_HYPOTHESES,
  }),
});
export type AgentConfig = Schema.Schema.Type<typeof AgentConfig>;

/** Mirror of `DEFAULT_MAX_PROMPT_HYPOTHESES` in prompt.ts — kept here so the default-fn can reference it. */
export const DEFAULT_MAX_PROMPT_HYPOTHESES = 50;

/** Decode unknown input as AgentConfig. Throws on bad input. */
export const parseAgentConfig = Schema.decodeUnknownSync(AgentConfig);

/**
 * Default config used by tests + smoke runs that don't supply one.
 * Explicitly sets `provider: "mock"` so the legacy `buildLlmLayer`
 * path still routes to the canned layer — the schema relaxation
 * removed the implicit default; this literal re-establishes it for
 * callers that depended on the smoke-friendly behaviour.
 */
export const defaultAgentConfig: AgentConfig = parseAgentConfig({
  provider: "mock",
});
