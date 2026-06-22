/**
 * packages/llm/src/errors.ts — typed error surface for the LLM layer (C1).
 *
 * Three failure modes the supervisor loop cares about:
 *   - LlmCompletionError — the SDK call itself failed (network, auth,
 *     rate limit, model refused). The CLI should retry with
 *     exponential backoff; the dashboard surfaces it verbatim.
 *   - JsonParseError — the model returned something that is not
 *     valid JSON. Usually a "Sure! Here's the JSON: …" preamble or
 *     a markdown fence. The supervisor retries with a stronger
 *     prompt; the raw text is attached for diagnostics.
 *   - SchemaValidationError — the model returned valid JSON that
 *     fails the Effect Schema. The supervisor retries with the
 *     schema echoed back; the raw text is attached.
 *
 * All three are tagged so `Effect.catchTag` discriminates cleanly.
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

export class JsonParseError extends Error {
  override readonly name = "JsonParseError";
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
  }
}

export class SchemaValidationError extends Error {
  override readonly name = "SchemaValidationError";
  constructor(
    message: string,
    readonly raw: string,
    readonly issues: string,
  ) {
    super(message);
  }
}

/** Error union the JSON completion path can fail with. */
export type JsonCompletionError = LlmCompletionError | JsonParseError | SchemaValidationError;
