/**
 * packages/llm/src/resolve-model.ts — model + alias resolution (new schema).
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §2
 * (LiteLLM variant).
 *
 * The new `LlmConfig` schema routes every call through a single
 * LiteLLM-compatible proxy (`base_url` + `api_key_env`). Models are
 * addressed by upstream id (e.g. `claude-sonnet-4-6`,
 * `gpt-4o-mini`) OR by a user-defined alias from `llm.model_aliases`.
 *
 * Resolution order for a given command:
 *
 *   1. CLI flag (when caller passes `flagModel`)
 *   2. `llm.commands[<cmd>].model` (literal model id)
 *   3. `llm.commands[<cmd>].alias` (looked up in `llm.model_aliases`)
 *   4. `llm.default_model`
 *   5. throw `LlmCompletionError` with the canonical "no model configured"
 *      message (matches spec AC #8).
 *
 * The returned string is the **upstream model id** the proxy should
 * dispatch to. Aliases are resolved here so the layer / ask command
 * only ever sees upstream ids; the proxy is provider-agnostic.
 */

import type { LlmConfig } from "@cognit/core";
import { LlmCompletionError } from "./errors.js";

/** Which command is asking for a model. Maps to the matching
 *  `llm.commands.<cmd>` override key. New commands add their name
 *  here + to the `LlmCommandConfig` schema in `@cognit/core/config`. */
export type ResolveModelCommand = "ask" | "agent_run";

const NO_MODEL_CONFIGURED =
  "no model configured (set llm.default_model or pass --model)";

/**
 * Pure function — no process I/O. Trivial to unit-test.
 *
 * Throws `LlmCompletionError` when nothing resolves. The CLI
 * surfaces the message verbatim so operators can grep automation
 * for the canonical string.
 */
export const resolveModel = (
  llm: LlmConfig,
  cmd: ResolveModelCommand,
  flagModel?: string,
): string => {
  if (flagModel !== undefined && flagModel.trim() !== "") {
    return flagModel.trim();
  }
  const cmdCfg = llm.commands[cmd];
  if (cmdCfg?.model !== undefined && cmdCfg.model.trim() !== "") {
    return cmdCfg.model.trim();
  }
  if (cmdCfg?.alias !== undefined && cmdCfg.alias.trim() !== "") {
    const alias = cmdCfg.alias.trim();
    const resolved = llm.model_aliases[alias];
    if (resolved !== undefined && resolved.trim() !== "") {
      return resolved.trim();
    }
  }
  if (llm.default_model !== undefined && llm.default_model.trim() !== "") {
    return llm.default_model.trim();
  }
  throw new LlmCompletionError(NO_MODEL_CONFIGURED);
};

/**
 * Read the API key from `process.env[llm.api_key_env]`. Trims the
 * value. Throws `LlmCompletionError` (with the exact env var name
 * in the message) when missing or empty — matches the boot check
 * contract that `LlmLive` enforces at build time.
 */
export const resolveApiKey = (llm: LlmConfig): string => {
  const name = llm.api_key_env;
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new LlmCompletionError(
      `required env ${name} not set (source: llm.api_key_env)`,
    );
  }
  return raw.trim();
};