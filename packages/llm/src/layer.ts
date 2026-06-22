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
 * Retry policy: the wrapped Effect is retried with exponential
 * backoff (100ms, 200ms, 400ms — capped at 3 recurs). This is the
 * default; the CLI / supervisor should NOT layer its own retry on
 * top. The schedule is wrapped via `Effect.retry` so any
 * `LlmCompletionError` re-runs the SDK call.
 *
 * Cancellation: the caller's `AbortSignal` is threaded through to
 * `generateText({ abortSignal })`. The retry schedule does NOT
 * retry aborted calls — `Effect.retry`'s `while` predicate skips
 * when the underlying cause has `name === "AbortError"`.
 *
 * The Layer's R-channel is `never`: no runtime deps after the
 * factory returns. This is intentional — by the time the layer
 * is built, the env vars are checked and the model object is
 * captured in the closure.
 */

import { generateText } from "ai";
import type { AgentConfig, LlmProviderShape } from "@cognit/agent";
import { LlmProvider } from "@cognit/agent";
import { Effect, Layer, Schedule } from "effect";
import { assertEnvFor, modelFor } from "./provider.js";
import { extendWithJson } from "./json.js";
import { LlmCompletionError } from "./errors.js";

/**
 * Retry policy for transient SDK failures. Exponential backoff
 * starting at 100ms, doubling each time, capped at 3 recurs.
 * Applies only to `LlmCompletionError` — abort / cancellation
 * bypasses the retry (handled inside the wrapped Effect).
 *
 * Exported so tests can pin it (changing the schedule changes
 * observed retry counts in the retry test).
 */
export const LLM_RETRY_SCHEDULE = Schedule.exponential("100 millis").pipe(
  Schedule.compose(Schedule.recurs(3)),
);

/**
 * Build the raw provider shape that wraps the Vercel AI SDK. Pure
 * factory — no Layer, no env reads, easy to unit-test.
 *
 * The shape's `complete` accepts an optional `signal` and threads
 * it into `generateText({ abortSignal })`. The retry policy
 * re-runs on `LlmCompletionError`; aborts are not retried.
 */
export const llmShapeFor = (cfg: AgentConfig): LlmProviderShape => ({
  complete: ({ prompt, model, signal }) =>
    Effect.tryPromise({
      try: async () => {
        const result = await generateText({
          model: modelFor(cfg.provider, model),
          prompt,
          ...(signal ? { abortSignal: signal } : {}),
        });
        return result.text;
      },
      catch: (e) =>
        new LlmCompletionError(
          `llm: generateText failed: ${(e as Error).message ?? String(e)}`,
          e,
        ),
    }).pipe(
      // Retry only on transient `LlmCompletionError` failures. Skip
      // when the underlying cause is an abort — the caller asked us
      // to stop, retrying would be a bug. The Vercel AI SDK throws
      // a DOMException with `name === "AbortError"` on signal.
      Effect.retry({
        schedule: LLM_RETRY_SCHEDULE,
        while: (e) =>
          !(e instanceof LlmCompletionError) ||
          !(e.cause instanceof Error) ||
          e.cause.name !== "AbortError",
      }),
    ),
});

/**
 * Build a Layer that satisfies `@cognit/agent`'s LlmProvider Tag
 * with the JSON-aware extended shape (`complete` + `completeJson`).
 *
 * Throws synchronously on `Layer.succeed` construction if the
 * provider's env var is missing — call inside an Effect's `Effect.gen`
 * or wrap in `Effect.sync` if the caller wants the failure in the
 * error channel rather than throwing.
 *
 * R-channel is explicitly `never`: by the time the factory
 * returns, env vars are checked and the model object is captured
 * in the closure. E-channel is also `never` because the Layer is
 * `Layer.succeed` (no build-time Effect).
 */
export const LlmLive = (cfg: AgentConfig): Layer.Layer<LlmProvider, never, never> => {
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
 *
 * Same `Layer.Layer<LlmProvider, never, never>` annotation as
 * `LlmLive` — R and E channels are both `never`.
 */
export const LlmLiveLazy = (cfg: AgentConfig): Layer.Layer<LlmProvider, never, never> => {
  const shape = extendWithJson(llmShapeFor(cfg));
  return Layer.succeed(LlmProvider)(shape);
};