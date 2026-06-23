/**
 * @cognit/llm — Vercel AI SDK provider layer (C1).
 *
 * Public surface:
 *   - `LlmLive(cfg)` / `LlmLiveLazy(cfg)` — Layers satisfying
 *     `@cognit/agent`'s `LlmProvider` Tag
 *   - `modelFor(provider, modelId)` — pure SDK model factory
 *   - `assertEnvFor` / `requireEnvFor` / `ENV_VAR_BY_PROVIDER` —
 *     env-var surface for boot-time checks
 *   - `makeCompleteJson` / `extendWithJson` / `JSON_OUTPUT_INSTRUCTION` —
 *     typed JSON completion helper (re-exported by tests)
 *   - `LlmCompletionError` / `JsonParseError` / `SchemaValidationError`
 *     — typed error surface
 *
 * Dependency direction: `packages/agent` defines the `LlmProvider`
 * Tag and the prompt builder. `packages/llm` provides a concrete
 * Layer that satisfies it. No reverse dependency.
 *
 * The package owns:
 *   - the Vercel AI SDK wrapper (`generateText`)
 *   - the JSON parse + Effect Schema validation step
 *   - the env-var boot check
 *
 * The agent package keeps ownership of:
 *   - the `AgentDecision` schema
 *   - the prompt builder
 *   - the loop orchestration
 */
export {
  LlmLive,
  LlmLiveLazy,
  LlmLiveFromRoute,
  LlmLiveLazyFromRoute,
  llmShapeFor,
  gatewayShapeFor,
} from "./layer.js";

export {
  gatewayModel,
  gatewayModelFor,
  resolveGatewayRoute,
  type GatewayRoute,
} from "./gateway.js";

export {
  modelFor,
  ENV_VAR_BY_PROVIDER,
  requireEnvFor,
  assertEnvFor,
} from "./provider.js";

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
