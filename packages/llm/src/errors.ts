/**
 * packages/llm/src/errors.ts — typed error surface for the LLM layer (C1).
 *
 * The error classes are owned by `@cognit/agent` (which is upstream
 * of `@cognit/llm` in the dep graph). `@cognit/llm` re-exports them
 * here so:
 *
 *   1. Internal imports (`./json.js`, `./layer.js`, `./provider.js`)
 *      have a local path to import from — keeps relative-path noise
 *      out of `layer.ts`.
 *   2. External callers can `import { LlmCompletionError } from "@cognit/llm"`
 *      without caring which package owns the canonical class.
 *
 * These are NOT new classes — they are re-exports of the agent
 * package's classes. `instanceof` checks against either import path
 * succeed because they resolve to the same constructor.
 *
 * Retry semantics: `@cognit/llm`'s `LlmLive` layer wraps `generateText`
 * in an `Effect.retry` policy (exponential backoff, 3 recurs). The
 * CLI does not need to layer its own retry on top — if it does, the
 * effective retry count is the product.
 */

export {
  LlmCompletionError,
  JsonParseError,
  SchemaValidationError,
  type JsonCompletionError,
} from "@cognit/agent";