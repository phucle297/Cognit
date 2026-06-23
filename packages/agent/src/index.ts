/**
 * @cognit/agent — phase C2 AI supervisor.
 *
 * Public surface:
 *   - `AgentDecision`, `AgentAction`, `RankOverride` (Effect Schemas)
 *   - `decodeAgentDecisionEither`, `encodeAgentDecision`
 *   - `AgentConfig`, `parseAgentConfig`, `defaultAgentConfig`
 *   - `buildPrompt` (pure SessionState → string)
 *   - `applyDecision` (AgentDecision → EventStore.append Effect)
 *   - `runTick` (full supervisor loop Effect)
 *   - `LlmProvider` (Tag) + `llmProviderFrom` (Layer)
 *
 * The package depends on `@cognit/core` (types + reducer) and
 * `@cognit/db` (EventStore + Uuid). It does NOT depend on
 * `@cognit/server`, `@cognit/dashboard`, or `@cognit/cli`. The CLI
 * layer-build step is responsible for composing `LlmProvider` from
 * C1's `@cognit/llm` package at runtime.
 */
export {
  AgentAction,
  AgentDecision,
  RankOverride,
  decodeAgentDecisionEither,
  encodeAgentDecision,
  type AgentAction as AgentActionT,
  type AgentDecision as AgentDecisionT,
  type RankOverride as RankOverrideT,
} from "./decision.js";

export {
  AgentConfig,
  DEFAULT_MAX_PROMPT_HYPOTHESES,
  defaultAgentConfig,
  parseAgentConfig,
  type AgentConfig as AgentConfigT,
} from "./agent-config.js";

export {
  DEFAULT_MAX_PROMPT_HYPOTHESES as DEFAULT_MAX_PROMPT_HYPOTHESES_FROM_PROMPT,
  buildPrompt,
} from "./prompt.js";

export {
  applyDecision,
  actionEventId,
  rankOverrideEventId,
  type AppliedAction,
  type ApplyTickResult,
  type ApplyError,
} from "./apply.js";

export {
  DecisionParseError,
  runTick,
  type RunTickInput,
  type TickError,
  type TickResult,
} from "./loop.js";

export {
  LlmProvider,
  llmProviderFrom,
  type LlmProviderShape,
} from "./llm.js";

export {
  LlmCompletionError,
  JsonParseError,
  SchemaValidationError,
  type JsonCompletionError,
} from "./errors.js";
