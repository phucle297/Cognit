/**
 * packages/agent/src/llm.ts — LLM provider abstraction (C2).
 *
 * The supervisor loop needs ONE thing from an LLM: given a prompt,
 * return the model's completion as a string. Parsing + schema
 * validation happens in the loop (`decodeAgentDecisionEither`) so
 * the provider boundary stays trivial and C1 (`packages/llm/`) is
 * free to choose any underlying SDK (Vercel AI SDK, raw fetch,
 * local inference, mock).
 *
 * Why not return a typed `AgentDecision` directly? Two reasons:
 *   1. Providers that stream tokens or chunk outputs need to push
 *      partial strings; coercion to `AgentDecision` would require
 *      them to know the agent schema (reverse dependency).
 *   2. Tests for the loop want to inject a fixture that returns
 *      malformed JSON on purpose to assert the parse-error path.
 *      A string-returning mock is one line; a typed-decision mock
 *      would have to side-step the schema.
 *
 * The provider is an Effect `Tag` so the loop composes with the
 * rest of the db/core services (DI via R-channel, swap-in tests,
 * Layer composition in the CLI).
 */

import { Context, Effect, Layer } from "effect";

/**
 * Raw completion error. The supervisor loop translates this into
 * a typed `AgentTickError` with the cause attached so the CLI can
 * log + retry or surface a dashboard error.
 */
export class LlmCompletionError extends Error {
  override readonly name = "LlmCompletionError";
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface LlmProviderShape {
  /**
   * Complete a prompt. Pure Effect — the provider is responsible for
   * any retries, cancellation, and I/O. The returned string is the
   * model's full completion; the caller parses + validates.
   *
   * `model` is passed in so a single provider implementation can
   * route to multiple underlying models (e.g. anthropic's
   * claude-opus-4-8 vs claude-haiku-4-5-20251001). The provider
   * validates the model against its own allow-list.
   */
  readonly complete: (input: {
    readonly prompt: string;
    readonly model: string;
  }) => Effect.Effect<string, LlmCompletionError>;
}

export class LlmProvider extends Context.Tag("@cognit/agent/LlmProvider")<
  LlmProvider,
  LlmProviderShape
>() {}

/**
 * A static `LlmProvider` Layer built from a plain function. Tests use
 * this to inject canned responses; C1 uses it to wrap the Vercel AI
 * SDK provider.
 */
export const llmProviderFrom = (
  complete: LlmProviderShape["complete"],
): Layer.Layer<LlmProvider> => Layer.succeed(LlmProvider)({ complete });
