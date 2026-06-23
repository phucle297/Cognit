/**
 * apps/cli/src/config-resolver.ts — shared model + key resolution.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §2.
 *
 * The same resolution rules drive `cognit ask`, `cognit agent run`,
 * and any future LLM-touching command. Centralising the logic here
 * means every command reads `cognit.yaml → llm.*` the same way and
 * every error message matches the spec's acceptance criteria
 * verbatim (so operators can grep for them).
 *
 * Public surface:
 *   - `resolveModel(llm, cmd, flagModel?)` — pick the upstream
 *     model id (alias → literal → default_model)
 *   - `resolveApiKey(llm)` — env var value (reads process.env)
 *
 * Errors:
 *   - Missing model → `LlmCompletionError` with the canonical message
 *     from spec AC #8 so the operator can grep automation for it.
 *   - Missing env var → `LlmCompletionError` with the exact env var
 *     name (matches spec AC #7). The schema defaults
 *     `llm.api_key_env` so this branch is defence-in-depth.
 *
 * Per-model override (`llm.models[<id>].api_key_env`) is gone in
 * the new LiteLLM-proxy schema — all calls share a single proxy +
 * single API key. The CLI therefore resolves the env var once per
 * command and passes the `LlmConfig` block through verbatim to
 * `LlmLive` / `LlmLiveLazy`.
 */

import { LlmCompletionError } from "@cognit/agent";
import type { LlmConfig } from "@cognit/core";

/**
 * Which command is asking for a model. Maps to the matching
 * `llm.commands.<cmd>` override key in `cognit.yaml`. New
 * commands add their name here + to the `LlmCommandConfig` schema
 * in `@cognit/core/config`.
 */
export type ResolverCommand = "ask" | "agent_run";

/**
 * Resolve which upstream model id to use for a command. Order per
 * spec §2:
 *
 *   1. CLI flag (`flagModel`) when set + non-empty
 *   2. `llm.commands[<cmd>].model` (literal model id)
 *   3. `llm.commands[<cmd>].alias` (looked up in `llm.model_aliases`)
 *   4. `llm.default_model`
 *   5. error: `no model configured (set llm.default_model or pass --model)`
 *
 * The error message matches spec AC #8 verbatim.
 *
 * Pure function — no process I/O. Trivial to unit-test.
 */
export const resolveModel = (
  llm: LlmConfig,
  cmd: ResolverCommand,
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
    const aliased = llm.model_aliases[alias];
    if (aliased !== undefined && aliased.trim() !== "") {
      return aliased.trim();
    }
  }
  if (llm.default_model !== undefined && llm.default_model.trim() !== "") {
    return llm.default_model.trim();
  }
  throw new LlmCompletionError(
    "no model configured (set llm.default_model or pass --model)",
  );
};

/**
 * Read the API key from `process.env[llm.api_key_env]`.
 *
 * Throws `LlmCompletionError` when the env var is unset or empty.
 * The message includes the exact env var name so operators can see
 * which YAML key feeds the missing var. Matches spec AC #7 verbatim.
 *
 * `process.env` is read at call time (not module load) so a key
 * rotated mid-process is picked up by the next call. The CLI does
 * its own env read here so it can fail fast with the canonical
 * message BEFORE any layer is built; the layer's own
 * `LlmLive` / `LlmLiveLazy` boot check defends against missing-env
 * at build time as a backstop.
 */
export const resolveApiKey = (llm: LlmConfig): string => {
  const apiKeyEnv = llm.api_key_env;
  const raw = process.env[apiKeyEnv];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new LlmCompletionError(
      `required env ${apiKeyEnv} not set (source: llm.api_key_env)`,
    );
  }
  return raw.trim();
};