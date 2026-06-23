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
 *   - `resolveModel(cfg, cmd, flagModel?)` — pick a Gateway model id
 *   - `resolveApiKeyEnv(cfg, model)` — env var name (no read)
 *   - `resolveApiKey(cfg, model)` — env var value (reads process.env)
 *
 * Errors:
 *   - Missing model → `LlmCompletionError` with the canonical message
 *     from spec AC #8 so the operator can grep automation for it.
 *   - Missing api_key_env → `LlmCompletionError` (defence-in-depth;
 *     the schema defaults `llm.api_key_env` so this branch should
 *     be unreachable in practice, but a hand-built config can hit it).
 *   - Missing env var → `LlmCompletionError` with the exact env var
 *     name + the source location (per-model override or default)
 *     from spec AC #7.
 */

import type { CognitConfig } from "@cognit/core/config";
import { LlmCompletionError } from "@cognit/agent";

/**
 * Which command is asking for a model. Maps to the matching
 * `llm.commands.<cmd>.model` override key in `cognit.yaml`. New
 * commands add their name here + to the `LlmCommandConfig` schema
 * in `@cognit/core/config`.
 */
export type ResolverCommand = "ask" | "agent_run";

/**
 * Resolve which Gateway model id to use for a command. Order per
 * spec §2:
 *
 *   1. CLI flag (`flagModel`) when set + non-empty
 *   2. `llm.commands[<cmd>].model`
 *   3. `llm.default_model`
 *   4. error: `no model configured (set llm.default_model or pass --model)`
 *
 * The error message matches spec AC #8 verbatim.
 *
 * Pure function — no process I/O. Trivial to unit-test.
 */
export const resolveModel = (
  cfg: CognitConfig,
  cmd: ResolverCommand,
  flagModel?: string,
): string => {
  if (flagModel !== undefined && flagModel.trim() !== "") {
    return flagModel.trim();
  }
  const cmdModel = cfg.llm.commands[cmd]?.model;
  if (cmdModel !== undefined && cmdModel.trim() !== "") {
    return cmdModel.trim();
  }
  if (cfg.llm.default_model !== undefined && cfg.llm.default_model.trim() !== "") {
    return cfg.llm.default_model.trim();
  }
  throw new LlmCompletionError(
    "no model configured (set llm.default_model or pass --model)",
  );
};

/**
 * Resolve which env var holds the API key for a given model.
 *
 * Order per spec §2:
 *   1. `llm.models[<model>].api_key_env` (per-model override)
 *   2. `llm.api_key_env` (default)
 *
 * Returns the env var name (NOT the value). The caller reads
 * `process.env[name]` separately so this function stays pure and
 * testable without process state.
 *
 * The schema defaults `llm.api_key_env` to `"AI_GATEWAY_API_KEY"`,
 * so this function effectively always returns a name when the
 * config is parsed from YAML. The fallback path is a defensive
 * guard for hand-built `CognitConfig` values (e.g. tests).
 */
export const resolveApiKeyEnv = (
  cfg: CognitConfig,
  model: string,
): string => {
  const override = cfg.llm.models[model];
  const apiKeyEnv = override?.api_key_env ?? cfg.llm.api_key_env;
  if (!apiKeyEnv) {
    throw new LlmCompletionError(
      `gateway route: no api_key_env resolved for model ${model} ` +
        `(set llm.api_key_env or llm.models.${model}.api_key_env)`,
    );
  }
  return apiKeyEnv;
};

/**
 * Read the API key for a model from its resolved env var.
 *
 * Throws `LlmCompletionError` when the env var is unset or empty.
 * The message includes both the env var name AND the source
 * location (`llm.models.<model>.api_key_env` or `llm.api_key_env`)
 * so operators can see exactly which YAML key feeds the missing
 * var. Matches spec AC #7 verbatim.
 *
 * `process.env` is read at call time (not module load) so a key
 * rotated mid-process is picked up by the next call. The same
 * behaviour is shared with `gatewayModelFor` in `@cognit/llm`.
 */
export const resolveApiKey = (
  cfg: CognitConfig,
  model: string,
): string => {
  const apiKeyEnv = resolveApiKeyEnv(cfg, model);
  const raw = process.env[apiKeyEnv];
  if (typeof raw !== "string" || raw.trim() === "") {
    const source = cfg.llm.models[model]?.api_key_env
      ? `llm.models.${model}.api_key_env`
      : "llm.api_key_env";
    throw new LlmCompletionError(
      `required env ${apiKeyEnv} not set (model ${model}, source: ${source})`,
    );
  }
  return raw.trim();
};
