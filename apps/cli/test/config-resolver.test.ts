/**
 * apps/cli/test/config-resolver.test.ts — model + key resolution.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §2.
 *
 * Resolution order for `resolveModel`:
 *   1. CLI flag
 *   2. llm.commands[<cmd>].model
 *   3. llm.default_model
 *   4. error
 *
 * Resolution order for `resolveApiKeyEnv` / `resolveApiKey`:
 *   1. llm.models[<model>].api_key_env (per-model override)
 *   2. llm.api_key_env (default)
 *
 * Cases:
 *   resolveModel
 *    1. flag wins over commands.ask.model
 *    2. flag wins over llm.default_model
 *    3. commands.ask.model wins when no flag
 *    4. commands.agent_run.model wins for agent_run command
 *    5. llm.default_model wins when no flag + no per-command override
 *    6. throws LlmCompletionError with canonical message when none set
 *    7. whitespace-only flag falls through to next source
 *    8. whitespace-only per-command override falls through
 *
 *   resolveApiKeyEnv
 *    9. per-model override wins over llm.api_key_env
 *   10. falls back to llm.api_key_env when no override
 *   11. throws when both unset (defensive — schema default prevents it)
 *
 *   resolveApiKey
 *   12. returns trimmed value when env set
 *   13. throws with canonical message when env unset (spec AC #7)
 *   14. throws when env set but empty / whitespace
 *   15. message names the per-model source when override is used
 *   16. message names llm.api_key_env source when no override
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { defaultConfig, parseCognitConfig, type CognitConfig } from "@cognit/core/config";
import { LlmCompletionError } from "@cognit/agent";
import {
  resolveApiKey,
  resolveApiKeyEnv,
  resolveModel,
} from "../src/config-resolver.js";

// --- helpers ------------------------------------------------------------

const ENV_KEYS_TO_RESTORE = ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
const SAVED_ENV: Record<string, string | undefined> = {};

const clearEnv = () => {
  for (const k of ENV_KEYS_TO_RESTORE) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
};

const restoreEnv = () => {
  for (const k of ENV_KEYS_TO_RESTORE) {
    const v = SAVED_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

const baseCfg = (): CognitConfig => defaultConfig("test");

const withDefaultModel = (model: string): CognitConfig =>
  parseCognitConfig({ project: { name: "test" }, llm: { default_model: model } });

const withCommandModel = (cmd: "ask" | "agent_run", model: string): CognitConfig =>
  parseCognitConfig({
    project: { name: "test" },
    llm: {
      default_model: "fallback/from/default",
      commands: { [cmd]: { model } },
    },
  });

const withModelOverride = (
  model: string,
  apiKeyEnv: string,
): CognitConfig =>
  parseCognitConfig({
    project: { name: "test" },
    llm: {
      default_model: model,
      models: { [model]: { api_key_env: apiKeyEnv } },
    },
  });

beforeEach(() => clearEnv());
afterEach(() => restoreEnv());

// --- resolveModel -------------------------------------------------------

describe("resolveModel — spec §2 order", () => {
  it("1. CLI flag wins over commands.ask.model", () => {
    const cfg = withCommandModel("ask", "from/commands/ask");
    expect(resolveModel(cfg, "ask", "from/flag")).toBe("from/flag");
  });

  it("2. CLI flag wins over llm.default_model", () => {
    const cfg = withDefaultModel("from/default");
    expect(resolveModel(cfg, "ask", "from/flag")).toBe("from/flag");
  });

  it("3. commands.ask.model wins when no flag", () => {
    const cfg = withCommandModel("ask", "from/commands/ask");
    expect(resolveModel(cfg, "ask")).toBe("from/commands/ask");
  });

  it("4. commands.agent_run.model wins for agent_run command", () => {
    const cfg = withCommandModel("agent_run", "from/commands/agent_run");
    expect(resolveModel(cfg, "agent_run")).toBe("from/commands/agent_run");
  });

  it("5. llm.default_model wins when no flag + no per-command override", () => {
    const cfg = withDefaultModel("from/default");
    expect(resolveModel(cfg, "ask")).toBe("from/default");
  });

  it("6. throws LlmCompletionError with canonical message when none set", () => {
    const cfg = baseCfg();
    expect(() => resolveModel(cfg, "ask")).toThrow(LlmCompletionError);
    expect(() => resolveModel(cfg, "ask")).toThrow(
      "no model configured (set llm.default_model or pass --model)",
    );
  });

  it("7. whitespace-only flag falls through to per-command override", () => {
    const cfg = withCommandModel("ask", "from/commands/ask");
    expect(resolveModel(cfg, "ask", "   ")).toBe("from/commands/ask");
  });

  it("8. whitespace-only per-command override falls through to default", () => {
    const cfg = parseCognitConfig({
      project: { name: "test" },
      llm: {
        default_model: "from/default",
        commands: { ask: { model: "   " } },
      },
    });
    expect(resolveModel(cfg, "ask")).toBe("from/default");
  });
});

// --- resolveApiKeyEnv ---------------------------------------------------

describe("resolveApiKeyEnv — per-model override > default", () => {
  it("9. per-model override wins over llm.api_key_env", () => {
    const cfg = parseCognitConfig({
      project: { name: "test" },
      llm: {
        api_key_env: "AI_GATEWAY_API_KEY",
        default_model: "anthropic/claude-sonnet-4-6",
        models: {
          "anthropic/claude-sonnet-4-6": { api_key_env: "ANTHROPIC_API_KEY" },
        },
      },
    });
    expect(resolveApiKeyEnv(cfg, "anthropic/claude-sonnet-4-6")).toBe(
      "ANTHROPIC_API_KEY",
    );
  });

  it("10. falls back to llm.api_key_env when no override", () => {
    const cfg = withDefaultModel("openai/gpt-4o");
    // Schema default for api_key_env is "AI_GATEWAY_API_KEY"
    expect(resolveApiKeyEnv(cfg, "openai/gpt-4o")).toBe("AI_GATEWAY_API_KEY");
  });

  it("11. throws when both unset (defensive — schema default prevents)", () => {
    // Build a config where both fields are empty strings so the
    // schema's optionalWith defaults kick in (which would still
    // give us "AI_GATEWAY_API_KEY"). To exercise the throw branch
    // we have to monkey-patch the parsed config object directly.
    const cfg = baseCfg();
    const broken = {
      ...cfg,
      llm: { ...cfg.llm, api_key_env: "" },
    };
    expect(() => resolveApiKeyEnv(broken, "any/model")).toThrow(LlmCompletionError);
  });
});

// --- resolveApiKey ------------------------------------------------------

describe("resolveApiKey — reads process.env, canonical error", () => {
  it("12. returns trimmed value when env set", () => {
    process.env.ANTHROPIC_API_KEY = "  sk-ant-fake  ";
    const cfg = withModelOverride("anthropic/claude-sonnet-4-6", "ANTHROPIC_API_KEY");
    expect(resolveApiKey(cfg, "anthropic/claude-sonnet-4-6")).toBe("sk-ant-fake");
  });

  it("13. throws with canonical message when env unset (spec AC #7)", () => {
    const cfg = withDefaultModel("anthropic/claude-sonnet-4-6");
    expect(() => resolveApiKey(cfg, "anthropic/claude-sonnet-4-6")).toThrow(
      LlmCompletionError,
    );
    expect(() => resolveApiKey(cfg, "anthropic/claude-sonnet-4-6")).toThrow(
      "required env AI_GATEWAY_API_KEY not set (model anthropic/claude-sonnet-4-6, source: llm.api_key_env)",
    );
  });

  it("14. throws when env set but empty / whitespace", () => {
    process.env.AI_GATEWAY_API_KEY = "   ";
    const cfg = withDefaultModel("openai/gpt-4o");
    expect(() => resolveApiKey(cfg, "openai/gpt-4o")).toThrow(LlmCompletionError);
  });

  it("15. message names per-model source when override is used", () => {
    const cfg = withModelOverride("anthropic/claude-sonnet-4-6", "ANTHROPIC_API_KEY");
    expect(() => resolveApiKey(cfg, "anthropic/claude-sonnet-4-6")).toThrow(
      "source: llm.models.anthropic/claude-sonnet-4-6.api_key_env",
    );
  });

  it("16. message names llm.api_key_env source when no override", () => {
    const cfg = withDefaultModel("openai/gpt-4o");
    expect(() => resolveApiKey(cfg, "openai/gpt-4o")).toThrow(
      "source: llm.api_key_env",
    );
  });
});
