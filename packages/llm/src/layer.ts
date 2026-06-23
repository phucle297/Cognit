/**
 * packages/llm/src/layer.ts — LlmLive factory (C1).
 *
 * Builds an `LlmProvider` Layer. Two factories:
 *
 *   - `LlmLiveFromRoute(llm)` — env-checked at build time. Throws
 *     `LlmCompletionError` when `AI_GATEWAY_API_KEY` (or the
 *     per-model override) is missing.
 *   - `LlmLiveLazyFromRoute(llm)` — env check deferred to first
 *     `complete()` call. Used by `cognit ask` so a misconfigured
 *     operator gets the canonical env-missing stderr message at
 *     runtime instead of a process-start crash.
 *
 * Both paths route every model call through the Vercel AI Gateway
 * via `gatewayModel(llm, modelId)`. The model id (e.g.
 * `anthropic/claude-sonnet-4-6`) is supplied per call — the layer
 * does not carry a single model; the supervisor loop decides per
 * tick.
 *
 * The canned `mock-1` model id is handled separately in
 * `apps/cli/src/layer-build.ts → buildLlmLayer`, which short-
 * circuits before the Gateway layer is built.
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
import type { LlmProviderShape } from "@cognit/agent";
import { LlmProvider } from "@cognit/agent";
import { Effect, Layer, Schedule } from "effect";
import type { LlmConfig } from "@cognit/core";
import { gatewayModel } from "./gateway.js";
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
 * Inner Effect that wraps `generateText` with retry + abort
 * filtering. The model factory runs inside `Effect.try` so a
 * synchronous throw from `buildModel()` (e.g. the Gateway layer's
 * env-key check failing on first call) surfaces as a typed
 * `LlmCompletionError` instead of escaping as an uncaught exception.
 *
 * The model is built lazily inside the Effect — not at
 * `complete()` invocation time — so tests that build a shape but
 * never call `complete()` do not pay the SDK-construction cost, and
 * consumers that wrap the Effect in `Effect.catchAll` /
 * `Effect.either` see the env-missing failure uniformly with SDK
 * failures.
 */
const generateTextEffect = (
  buildModel: () => Parameters<typeof generateText>[0]["model"],
  prompt: string,
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const sdkModel = yield* Effect.try({
      try: () => buildModel(),
      catch: (e) =>
        e instanceof LlmCompletionError
          ? e
          : new LlmCompletionError(
              `llm: model build failed: ${(e as Error).message ?? String(e)}`,
              e,
            ),
    });
    return yield* Effect.tryPromise({
      try: async () => {
        const result = await generateText({
          model: sdkModel,
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
      Effect.retry({
        schedule: LLM_RETRY_SCHEDULE,
        while: (e) =>
          !(e instanceof LlmCompletionError) ||
          !(e.cause instanceof Error) ||
          e.cause.name !== "AbortError",
      }),
    );
  });

/**
 * Gateway-routed shape. Resolves the API key per call from
 * `llm.models[<model>].api_key_env` or `llm.api_key_env`. The model
 * id flows through per-call so the supervisor loop can switch
 * models between ticks without rebuilding the layer.
 */
export const gatewayShapeFor = (llm: LlmConfig): LlmProviderShape => ({
  complete: ({ prompt, model, signal }) =>
    generateTextEffect(() => gatewayModel(llm, model), prompt, signal),
});

/**
 * Gateway Layer factory. Reads `AI_GATEWAY_API_KEY` (or per-model
 * override) at build time; throws `LlmCompletionError` if missing.
 * The model id is captured as `llm.default_model` if set so that
 * a bare `LlmLiveFromRoute(llm)` works for the common case where
 * the supervisor uses a single configured model. The supervisor
 * can still pass a different model per call via `complete({ model
 * })` — the per-model key override path handles that.
 */
export const LlmLiveFromRoute = (
  llm: LlmConfig,
): Layer.Layer<LlmProvider, never, never> => {
  // Validate the boot model so a missing key fails at build time.
  // Pick llm.default_model when set; otherwise probe with an empty
  // string to surface env-missing in the canonical form. We use a
  // throwaway model id ("") for the probe because we only need the
  // env check, not a real SDK call.
  const probeModel = llm.default_model ?? "";
  // Force env read at build. Throws when missing.
  gatewayModel(llm, probeModel);
  const shape = extendWithJson(gatewayShapeFor(llm));
  return Layer.succeed(LlmProvider)(shape);
};

/**
 * Lazy Gateway Layer factory. Env check deferred to first call —
 * the `cognit ask` command uses this so a missing key prints the
 * friendly env-var error to stderr with the right exit code rather
 * than crashing the process.
 */
export const LlmLiveLazyFromRoute = (
  llm: LlmConfig,
): Layer.Layer<LlmProvider, never, never> => {
  const shape = extendWithJson(gatewayShapeFor(llm));
  return Layer.succeed(LlmProvider)(shape);
};
