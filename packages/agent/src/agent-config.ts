/**
 * packages/agent/src/agent-config.ts — agent.* config block schema (C2).
 *
 * Standalone schema (not yet merged into CognitConfigSchema in
 * `@cognit/core`) so the agent package stays self-contained for
 * tests and CLI wiring. The CLI layer-build step is responsible for
 * reading `cognit.yaml → agent.*` and producing a Layer that satisfies
 * the `AgentConfig` tag defined here.
 *
 * `provider` is a closed literal list — adding a new provider is an
 * explicit type break, forcing the implementer to touch both
 * `@cognit/llm` (C1) and `@cognit/agent` rather than letting a typo
 * silently route to a missing implementation.
 */

import { Schema } from "effect";

const PositiveInt = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0));
const NonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0));

export const AgentProvider = Schema.Literal("anthropic", "openai", "google", "ollama", "mock");
export type AgentProvider = Schema.Schema.Type<typeof AgentProvider>;

export const AgentConfig = Schema.Struct({
  provider: Schema.optionalWith(AgentProvider, { default: () => "mock" as const }),
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

/** Default config used when none is supplied (tests, smoke runs). */
export const defaultAgentConfig: AgentConfig = parseAgentConfig({});
