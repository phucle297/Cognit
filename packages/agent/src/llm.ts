/**
 * packages/agent/src/llm.ts — LLM provider abstraction (C2).
 *
 * The supervisor loop needs an LLM to emit text per tick. We define
 * two methods on the provider:
 *
 *   - `complete({ prompt, model })` → Effect<string, LlmCompletionError>
 *       Raw text completion. The supervisor loop uses this when no
 *       schema-aware helper is available (mock provider, future
 *       non-AI backends).
 *
 *   - `completeJson({ prompt, model, provider, schema })` → Effect<T, …>
 *       Typed completion. The C1 concrete layer
 *       (`@cognit/llm`) wraps the model output with a JSON
 *       parse + Effect Schema validation step. The loop prefers
 *       this when available so the parse error class is unified.
 *
 * The provider is an Effect `Tag` so the loop composes with the
 * rest of the db/core services (DI via R-channel, swap-in tests,
 * Layer composition in the CLI).
 */

import { Context, Effect, Layer, Schema } from "effect";
import type { AgentProvider } from "./agent-config.js";
import {
  JsonParseError,
  LlmCompletionError,
  SchemaValidationError,
} from "./errors.js";

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
  /**
   * Typed JSON completion. Optional — providers that do not
   * implement it (e.g. the mock layer used by tests) leave the
   * supervisor loop to parse + validate from `complete()`. The C1
   * concrete layer (`@cognit/llm`) implements both methods.
   */
  readonly completeJson?: <T>(
    input: {
      readonly prompt: string;
      readonly model: string;
      readonly provider: AgentProvider;
      readonly schema: Schema.Schema<T>;
    },
  ) => Effect.Effect<
    T,
    LlmCompletionError | JsonParseError | SchemaValidationError
  >;
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
