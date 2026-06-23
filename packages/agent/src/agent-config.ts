/**
 * packages/agent/src/agent-config.ts — agent.* config block schema (C2).
 *
 * Standalone schema (not yet merged into CognitConfigSchema in
 * `@cognit/core`) so the agent package stays self-contained for
 * tests and CLI wiring. The CLI layer-build step is responsible for
 * reading `cognit.yaml → agent.*` and producing a Layer that satisfies
 * the `AgentConfig` tag defined here.
 *
 * Routing decision: model id is the only signal. The legacy
 * closed-literal `provider` field was removed along with the
 * `--provider` CLI flag (Cognit-l06/007). All real-LLM calls go
 * through the Vercel AI Gateway using the full model id
 * (`<provider>/<id>`, e.g. `anthropic/claude-sonnet-4-6`). The
 * canned mock layer is reached when `model === "mock-1"` (the
 * default `model` value below).
 */

import { Schema } from "effect";

const PositiveInt = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0));
const NonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0));

export const AgentConfig = Schema.Struct({
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
 * `model: "mock-1"` routes to the canned layer in
 * `apps/cli/src/layer-build.ts → buildLlmLayer`, so `cognit init`
 * + `cognit agent run --once` works without an `llm:` block in
 * `cognit.yaml` and without any API key.
 */
export const defaultAgentConfig: AgentConfig = parseAgentConfig({});
