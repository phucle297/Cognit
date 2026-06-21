/**
 * packages/llm/src/layer.ts — LlmLive factory (C1).
 *
 * Builds an `LlmProvider` Layer from an `AgentConfig`. The Layer
 * depends on:
 *   - the SDK model object (built by `modelFor(provider, modelId)`)
 *   - the env-var assertion (`assertEnvFor(provider)`) — fails at
 *     layer-build time if the key is missing
 *
 * Calling `generateText` is wrapped in `Effect.tryPromise` so a
 * thrown SDK error becomes a typed `LlmCompletionError` in the
 * Effect error channel. The SDK does not have a typed error
 * surface in v6 — every failure is a thrown Error — so we catch
 * everything and re-throw with the original cause attached.
 *
 * The Layer's R-channel is `never`: no runtime deps after the
 * factory returns. This is intentional — by the time the layer
 * is built, the env vars are checked and the model object is
 * captured in the closure.
 */

import { generateText } from "ai";
import type { AgentConfig, LlmProviderShape } from "@cognit/agent";
import { LlmProvider } from "@cognit/agent";
import { Effect, Layer } from "effect";
import { assertEnvFor, modelFor } from "./provider.js";
import { extendWithJson } from "./json.js";
import { LlmCompletionError } from "./errors.js";

/**
 * Build the raw provider shape that wraps the Vercel AI SDK. Pure
 * factory — no Layer, no env reads, easy to unit-test.
 */
export const llmShapeFor = (cfg: AgentConfig): LlmProviderShape => ({
  complete: ({ prompt, model }) =>
    Effect.tryPromise({
      try: async () => {
        const result = await generateText({
          model: modelFor(cfg.provider, model),
          prompt,
        });
        return result.text;
      },
      catch: (e) =>
        new LlmCompletionError(
          `llm: generateText failed: ${(e as Error).message ?? String(e)}`,
          e,
        ),
    }),
});

/**
 * Build a Layer that satisfies `@cognit/agent`'s LlmProvider Tag
 * with the JSON-aware extended shape (`complete` + `completeJson`).
 *
 * Throws synchronously on `Layer.succeed` construction if the
 * provider's env var is missing — call inside an Effect's `Effect.gen`
 * or wrap in `Effect.sync` if the caller wants the failure in the
 * error channel rather than throwing.
 */
export const LlmLive = (cfg: AgentConfig): Layer.Layer<LlmProvider> => {
  assertEnvFor(cfg.provider);
  const shape = extendWithJson(llmShapeFor(cfg));
  return Layer.succeed(LlmProvider)(shape);
};

/**
 * Build the same Layer but with env-var check deferred to first
 * use (returns the Layer even when the env is missing; the first
 * `complete` call surfaces the failure). Useful for tests and for
 * CLI commands that want to print "missing env" as a friendly error
 * rather than crashing at process start.
 */
export const LlmLiveLazy = (cfg: AgentConfig): Layer.Layer<LlmProvider> => {
  const shape = extendWithJson(llmShapeFor(cfg));
  return Layer.succeed(LlmProvider)(shape);
};
