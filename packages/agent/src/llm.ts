/**
 * packages/agent/src/llm.ts — LLM provider abstraction (C2).
 *
 * The supervisor loop needs an LLM to emit text per tick. We define
 * two methods on the provider:
 *
 *   - `complete({ prompt, model, signal? })` → Effect<string, LlmCompletionError>
 *       Raw text completion. The supervisor loop uses this when no
 *       schema-aware helper is available (mock provider, future
 *       non-AI backends). The optional `signal` aborts the SDK call
 *       when the supervisor's per-tick budget is exceeded.
 *
 *   - `completeJson({ prompt, model, provider, schema, signal? })` → Effect<T, …>
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
   *
   * `signal` is forwarded to the underlying SDK call so the supervisor
   * loop can cancel an in-flight request when its tick budget expires
   * or the CLI is shutting down. Optional — providers without
   * cancellation support ignore it.
   */
  readonly complete: (input: {
    readonly prompt: string;
    readonly model: string;
    readonly signal?: AbortSignal;
  }) => Effect.Effect<string, LlmCompletionError>;
  /**
   * Typed JSON completion. Optional — providers that do not
   * implement it (e.g. the mock layer used in tests) leave the
   * supervisor loop to parse + validate from `complete()`. The C1
   * concrete layer (`@cognit/llm`) implements both methods.
   */
  readonly completeJson?: <T>(
    input: {
      readonly prompt: string;
      readonly model: string;
      /**
       * Optional. Legacy closed-literal provider; the Gateway path
       * ignores it (the model id carries the provider prefix). The
       * supervisor passes through `agent.provider` which is itself
       * optional post-Cognit-l06/005 relaxation.
       */
      readonly provider?: AgentProvider;
      readonly schema: Schema.Schema<T>;
      readonly signal?: AbortSignal;
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