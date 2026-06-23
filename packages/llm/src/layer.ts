/**
 * packages/llm/src/layer.ts — LlmLive factory (C1).
 *
 * Builds an `LlmProvider` Layer on top of `openaiComplete` (plain
 * `fetch` against `cfg.base_url + "/v1/chat/completions"`). Two
 * factories:
 *
 *   - `LlmLive(llm)` — env-checked at build time. Throws
 *     `LlmCompletionError` when `llm.api_key_env` is missing.
 *     Used by the supervisor loop / CLI bootstrap so a
 *     misconfigured operator fails fast with the canonical
 *     env-missing stderr message.
 *
 *   - `LlmLiveLazy(llm)` — env check deferred to first `complete()`
 *     call. Used by `cognit ask` so the same friendly env-var
 *     error surfaces from the prompt path rather than at process
 *     start.
 *
 * Retry policy (`LLM_RETRY_SCHEDULE`):
 *   Exponential backoff starting at 100ms, doubling each tick,
 *   capped at 3 recurs. Applied to every `LlmCompletionError` from
 *   the wrapped `openaiComplete` call.
 *
 *   Abort handling: when the underlying fetch is aborted (the
 *   caller's `AbortSignal` fires, or `AbortSignal.timeout` fires),
 *   the cause carries `name === "AbortError"`. The retry `while`
 *   predicate skips those — aborts should propagate immediately,
 *   not retry.
 *
 * The Layer's R-channel is `never`: no runtime deps after the
 * factory returns. By the time the layer is built, the env vars
 * are checked and the `openaiComplete` closure is captured.
 */

import type { LlmProviderShape } from "@cognit/agent";
import { LlmProvider } from "@cognit/agent";
import { Effect, Layer, Schedule } from "effect";
import type { LlmConfig } from "@cognit/core";
import { openaiComplete } from "./openai.js";
import { extendWithJson } from "./json.js";
import { LlmCompletionError } from "./errors.js";

/**
 * Retry policy for transient HTTP / proxy failures. Exponential
 * backoff starting at 100ms, doubling each time, capped at 3 recurs.
 *
 * Applies only to `LlmCompletionError`. Aborts (caller cancellation
 * or per-call timeout) bypass the retry — handled inside the
 * wrapped Effect via the `while` predicate on the cause's
 * `name === "AbortError"` check.
 *
 * Exported so tests can pin it (changing the schedule changes
 * observed retry counts in the retry test).
 */
export const LLM_RETRY_SCHEDULE = Schedule.exponential("100 millis").pipe(
  Schedule.compose(Schedule.recurs(3)),
);

/**
 * Inner Effect that wraps `openaiComplete` with retry + abort
 * filtering. The factory runs inside `Effect.tryPromise` so a
 * synchronous throw from the closure (env-key missing, malformed
 * response, HTTP non-2xx) surfaces as a typed `LlmCompletionError`
 * instead of escaping as an uncaught exception.
 *
 * Abort skip: when the fetch is aborted, `Effect.tryPromise` rejects
 * with the underlying DOMException (`name === "AbortError"`). The
 * `while` predicate on `Effect.retry` short-circuits so the abort
 * propagates on the first attempt without delay.
 */
const openaiCompleteEffect = (
  complete: ReturnType<typeof openaiComplete>,
  prompt: string,
  model: string,
  signal: AbortSignal | undefined,
) =>
  Effect.tryPromise({
    try: () => complete({ prompt, model, ...(signal ? { signal } : {}) }),
    catch: (e) =>
      e instanceof LlmCompletionError
        ? e
        : new LlmCompletionError(
            "llm: openai-compat completion failed: " +
              ((e as Error).message ?? String(e)),
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

/**
 * OpenAI-compat shape. The model id flows through per-call so the
 * supervisor loop can switch models between ticks without rebuilding
 * the layer.
 *
 * Exported (not internal) so the layer test can exercise the shape
 * directly without spinning up an Effect program for every case.
 */
export const openaiShapeFor = (llm: LlmConfig): LlmProviderShape => {
  const complete = openaiComplete(llm);
  return {
    complete: ({ prompt, model, signal }) =>
      openaiCompleteEffect(complete, prompt, model, signal),
  };
};

/**
 * OpenAI-compat Layer factory. Reads `llm.api_key_env` at build time;
 * throws `LlmCompletionError` if missing. The actual fetch is
 * deferred to first `complete()` call — the build-time check is
 * purely an env-var presence probe so a misconfigured operator
 * crashes the process with a clean error rather than a confusing
 * network failure on the first tick.
 */
export const LlmLive = (
  llm: LlmConfig,
): Layer.Layer<LlmProvider, never, never> => {
  // Probe env read at build. Throws when missing. We don't make a
  // real fetch — just the synchronous env check inside the closure.
  openaiComplete(llm);
  const shape = extendWithJson(openaiShapeFor(llm));
  return Layer.succeed(LlmProvider)(shape);
};

/**
 * Lazy OpenAI-compat Layer factory. Env check deferred to first
 * `complete()` call — the `cognit ask` command uses this so a
 * missing key prints the friendly env-var error to stderr with the
 * right exit code rather than crashing the process at startup.
 */
export const LlmLiveLazy = (
  llm: LlmConfig,
): Layer.Layer<LlmProvider, never, never> => {
  const shape = extendWithJson(openaiShapeFor(llm));
  return Layer.succeed(LlmProvider)(shape);
};

/**
 * Pick a model id from `LlmConfig.commands[<cmd>]`:
 *   1. If the command block pins an `alias`, resolve via
 *      `llm.model_aliases[alias]`.
 *   2. Else if the command block pins a literal `model`, use it.
 *   3. Else fall back to `llm.default_model`.
 *
 * When `cmd` is undefined (or no command block matches), the alias
 * / literal steps are skipped and only `default_model` is consulted.
 *
 * Note: this helper only handles command-level resolution. Per-call
 * overrides (e.g. `--model <id>`) are layered on top by the CLI
 * command (see `apps/cli/src/config-resolver.ts → resolveModel`).
 */
export const resolveModel = (
  llm: LlmConfig,
  cmd?: "ask" | "agent_run",
): string => {
  const cfg = cmd ? llm.commands[cmd] : undefined;
  if (cfg?.alias) {
    const aliased = llm.model_aliases[cfg.alias];
    if (aliased) return aliased;
  }
  if (cfg?.model) return cfg.model;
  if (llm.default_model) return llm.default_model;
  throw new LlmCompletionError(
    cmd
      ? `llm: no model resolved for command '${cmd}' (set llm.default_model, commands.${cmd}.model, or commands.${cmd}.alias)`
      : `llm: no default_model configured (set llm.default_model)`,
  );
};