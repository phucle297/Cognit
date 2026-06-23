/**
 * packages/llm/src/json.ts — JSON completion + Effect Schema validation (C1).
 *
 * Wraps the LlmProvider with a typed-completion helper:
 *
 *   completeJson({ prompt, model, schema, provider })
 *     → Effect<T, LlmCompletionError | JsonParseError | SchemaValidationError, LlmProvider>
 *
 * Two-phase validation:
 *
 *   1. JSON.parse on the raw completion. A model that prepends
 *      "Sure! Here is the JSON:" or wraps in ``` fences fails here
 *      with `JsonParseError`. The raw text is attached so the CLI
 *      can show what the model actually emitted.
 *
 *      A size cap (`MAX_RAW_BYTES`) guards against pathological
 *      responses (runaway generation, model echoing a long context
 *      back). Anything over the cap fails fast with a
 *      `JsonParseError("response too large")` carrying a truncated
 *      `raw` (first 1KB + "...") so the diagnostics payload stays
 *      bounded too.
 *
 *   2. Schema.decodeUnknown on the parsed JSON. A model that returns
 *      well-formed JSON that does not match the schema fails here
 *      with `SchemaValidationError`. The raw text + the Effect
 *      Schema issues tree are attached for diagnostics.
 *
 * The function wraps the original prompt with a JSON-output
 * instruction so the model has a stable contract regardless of the
 * caller's prompt phrasing. The wrapper is appended, not prepended,
 * so the caller's instruction ordering survives.
 */

import type { LlmProviderShape } from "@cognit/agent";
import { Effect, Schema } from "effect";
import { JsonParseError, LlmCompletionError, SchemaValidationError } from "./errors.js";

/**
 * Append a JSON-output instruction to a prompt. Kept as a constant
 * so tests can assert the wrapping format (changing it changes the
 * model's behaviour, which would invalidate any golden tests).
 */
export const JSON_OUTPUT_INSTRUCTION =
  "\n\nReturn ONLY valid JSON matching the schema described above. " +
  "Do not wrap the response in markdown fences. Do not add commentary.";

/**
 * Maximum raw-completion size before we reject without parsing.
 * 1 MiB is generous for a JSON-decoded AgentDecision (the schema
 * has at most a handful of actions / overrides per tick) but
 * small enough to keep `JsonParseError.raw` from bloating log
 * payloads if a model echoes context back.
 */
export const MAX_RAW_BYTES = 1024 * 1024;

/**
 * Truncation length for `JsonParseError.raw` when the raw exceeds
 * the cap. We keep the head (the part the model produced first,
 * usually the actual JSON) and append an ellipsis marker.
 */
export const RAW_TRUNCATE_BYTES = 1024;

export interface CompleteJsonInput<T> {
  readonly prompt: string;
  readonly model: string;
  readonly schema: Schema.Schema<T>;
  readonly signal?: AbortSignal;
}

/**
 * Build a `completeJson` closure that delegates to the existing
 * `complete` method. Pure: no I/O of its own. The provider's
 * `complete` returns `Effect<string, LlmCompletionError>` so the
 * closure's error union starts there and adds JSON + schema errors.
 */
export const makeCompleteJson =
  (complete: LlmProviderShape["complete"]) =>
  <T>(input: CompleteJsonInput<T>): Effect.Effect<
    T,
    LlmCompletionError | JsonParseError | SchemaValidationError
  > =>
    Effect.gen(function* () {
      // Wrap prompt with the JSON-output instruction. The caller is
      // responsible for describing the schema; this appends the
      // formatting instruction only. We conditionally include
      // `signal` so undefined is not passed under
      // `exactOptionalPropertyTypes: true`.
      const raw = yield* complete({
        prompt: input.prompt + JSON_OUTPUT_INSTRUCTION,
        model: input.model,
        ...(input.signal ? { signal: input.signal } : {}),
      });

      // Phase 0: size cap. A model that returns 1MB+ of text is
      // almost certainly echoing context back or has gone off the
      // rails — fail fast with a truncated raw so the supervisor
      // can decide whether to retry with a stronger prompt.
      if (raw.length > MAX_RAW_BYTES) {
        return yield* Effect.fail(
          new JsonParseError(
            "response too large",
            raw.slice(0, RAW_TRUNCATE_BYTES) + "...",
          ),
        );
      }

      // Phase 1: JSON.parse.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return yield* Effect.fail(
          new JsonParseError(
            `llm: completion is not valid JSON: ${(e as Error).message}`,
            raw,
          ),
        );
      }

      // Phase 2: schema decode.
      const decoded = Schema.decodeUnknownEither(
        input.schema as Schema.Schema<unknown>,
      )(parsed);
      if (decoded._tag === "Left") {
        return yield* Effect.fail(
          new SchemaValidationError(
            `llm: completion did not match schema: ${String(decoded.left)}`,
            raw,
            String(decoded.left),
          ),
        );
      }
      return decoded.right as T;
    });

/**
 * Convenience: extend an existing `LlmProviderShape` with a
 * `completeJson` method. Used by `LlmLive` to build the concrete
 * layer satisfying `@cognit/agent`'s interface.
 */
export const extendWithJson = (
  shape: LlmProviderShape,
): LlmProviderShape & {
  readonly completeJson: ReturnType<typeof makeCompleteJson>;
} => ({
  ...shape,
  completeJson: makeCompleteJson(shape.complete),
});
