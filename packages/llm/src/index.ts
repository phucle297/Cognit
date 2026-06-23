/**
 * @cognit/llm — LiteLLM proxy OpenAI-compat provider layer (C1).
 *
 * Public surface:
 *   - `LlmLive(llm)` / `LlmLiveLazy(llm)` —
 *     `fetch`-based Layers satisfying `@cognit/agent`'s
 *     `LlmProvider` Tag
 *   - `resolveModel(llm, cmd?)` — pick a model id from
 *     `llm.commands[cmd]` (alias → literal → default_model)
 *   - `LLM_RETRY_SCHEDULE` — pinned exponential-backoff schedule
 *     used by the live layer
 *   - `openaiComplete` / `OpenAiCompleteInput` — direct
 *     `/v1/chat/completions` caller (re-used by `cognit ask`'s
 *     bypass path)
 *   - `makeCompleteJson` / `extendWithJson` / `JSON_OUTPUT_INSTRUCTION` —
 *     typed JSON completion helper (re-exported by tests)
 *   - `LlmCompletionError` / `JsonParseError` / `SchemaValidationError`
 *     — typed error surface
 *   - Multimodal input resolution + clipboard helpers used by
 *     `cognit ask`
 *
 * Dependency direction: `packages/agent` defines the `LlmProvider`
 * Tag and the prompt builder. `packages/llm` provides a concrete
 * Layer that satisfies it. No reverse dependency.
 *
 * The package owns:
 *   - the OpenAI-compat `fetch` wrapper (`openaiComplete`)
 *   - the JSON parse + Effect Schema validation step
 *   - the env-var boot check
 *   - multimodal input classification
 *
 * The agent package keeps ownership of:
 *   - the `AgentDecision` schema
 *   - the prompt builder
 *   - the loop orchestration
 */
export {
  LlmLive,
  LlmLiveLazy,
  resolveModel,
  LLM_RETRY_SCHEDULE,
} from "./layer.js";

export {
  openaiComplete,
  type OpenAiCompleteInput,
} from "./openai.js";

export {
  makeCompleteJson,
  extendWithJson,
  JSON_OUTPUT_INSTRUCTION,
  type CompleteJsonInput,
} from "./json.js";

// Note: JSON_OUTPUT_INSTRUCTION is part of the public surface (used
// by both the supervisor loop and tests). Changing it changes the
// model's behaviour, so the value is pinned by `json.test.ts:10`.

export {
  LlmCompletionError,
  JsonParseError,
  SchemaValidationError,
  type JsonCompletionError,
} from "./errors.js";

export {
  resolveInput,
  autoDetectInput,
  classifyStdin,
  sniffMime,
  MultimodalError,
  type InputSource,
  type Attachment,
} from "./multimodal.js";

export {
  readClipboardImage,
  isClipboardSupported,
  platformClipboardName,
  detectPlatform,
  type Platform,
} from "./clipboard.js";