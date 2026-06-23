/**
 * apps/cli/test/config-resolver.test.ts — model + key resolution.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §2.
 *
 * Resolution order for `resolveModel(llm, cmd, flagModel?)`:
 *   1. CLI flag
 *   2. llm.commands[<cmd>].model
 *   3. llm.commands[<cmd>].alias (via llm.model_aliases)
 *   4. llm.default_model
 *   5. error
 *
 * `resolveApiKey(llm)` reads `process.env[llm.api_key_env]` and
 * throws with the canonical env-var-name message.
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
 *    9. alias resolves via llm.model_aliases
 *
 *   resolveApiKey
 *   10. returns trimmed value when env set
 *   11. throws with canonical message when env unset (spec AC #7)
 *   12. throws when env set but empty / whitespace
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseCognitConfig, type LlmConfig } from "@cognit/core/config";
import { LlmCompletionError } from "@cognit/agent";
import {
  resolveApiKey,
  resolveModel,
} from "../src/config-resolver.js";

// --- helpers ------------------------------------------------------------

const ENV_KEY = "LITELLM_MASTER_KEY";
const SAVED_ENV: Record<string, string | undefined> = {};

const clearEnv = () => {
  SAVED_ENV[ENV_KEY] = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
};

const restoreEnv = () => {
  const v = SAVED_ENV[ENV_KEY];
  if (v === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = v;
};

const llmWith = (overrides: Partial<LlmConfig>): LlmConfig =>
  parseCognitConfig({ project: { name: "test" }, llm: overrides }).llm;

const withDefaultModel = (model: string): LlmConfig =>
  llmWith({ default_model: model });

const withCommandModel = (cmd: "ask" | "agent_run", model: string): LlmConfig =>
  llmWith({
    default_model: "fallback/from/default",
    commands: { [cmd]: { model } },
  });

beforeEach(() => clearEnv());
afterEach(() => restoreEnv());

// --- resolveModel -------------------------------------------------------

describe("resolveModel — spec §2 order", () => {
  it("1. CLI flag wins over commands.ask.model", () => {
    const llm = withCommandModel("ask", "from/commands/ask");
    expect(resolveModel(llm, "ask", "from/flag")).toBe("from/flag");
  });

  it("2. CLI flag wins over llm.default_model", () => {
    const llm = withDefaultModel("from/default");
    expect(resolveModel(llm, "ask", "from/flag")).toBe("from/flag");
  });

  it("3. commands.ask.model wins when no flag", () => {
    const llm = withCommandModel("ask", "from/commands/ask");
    expect(resolveModel(llm, "ask")).toBe("from/commands/ask");
  });

  it("4. commands.agent_run.model wins for agent_run command", () => {
    const llm = withCommandModel("agent_run", "from/commands/agent_run");
    expect(resolveModel(llm, "agent_run")).toBe("from/commands/agent_run");
  });

  it("5. llm.default_model wins when no flag + no per-command override", () => {
    const llm = withDefaultModel("from/default");
    expect(resolveModel(llm, "ask")).toBe("from/default");
  });

  it("6. throws LlmCompletionError with canonical message when none set", () => {
    // Schema default gives a default_model, so exercise the throw
    // by overriding it to an empty string at the object level.
    const llm: LlmConfig = {
      ...llmWith({ default_model: "tmp" }),
      default_model: "",
    };
    expect(() => resolveModel(llm, "ask")).toThrow(LlmCompletionError);
    expect(() => resolveModel(llm, "ask")).toThrow(
      "no model configured (set llm.default_model or pass --model)",
    );
  });

  it("7. whitespace-only flag falls through to per-command override", () => {
    const llm = withCommandModel("ask", "from/commands/ask");
    expect(resolveModel(llm, "ask", "   ")).toBe("from/commands/ask");
  });

  it("8. whitespace-only per-command override falls through to default", () => {
    const llm = llmWith({
      default_model: "from/default",
      commands: { ask: { model: "   " } },
    });
    expect(resolveModel(llm, "ask")).toBe("from/default");
  });

  it("9. commands.<cmd>.alias resolves via llm.model_aliases", () => {
    const llm = llmWith({
      default_model: "from/default",
      model_aliases: { fast: "gpt-4o-mini", smart: "claude-sonnet-4-6" },
      commands: { ask: { alias: "fast" } },
    });
    expect(resolveModel(llm, "ask")).toBe("gpt-4o-mini");
  });
});

// --- resolveApiKey ------------------------------------------------------

describe("resolveApiKey — reads process.env, canonical error", () => {
  it("10. returns trimmed value when env set", () => {
    process.env[ENV_KEY] = "  sk-litellm-fake  ";
    const llm = llmWith({ api_key_env: ENV_KEY });
    expect(resolveApiKey(llm)).toBe("sk-litellm-fake");
  });

  it("11. throws with canonical message when env unset (spec AC #7)", () => {
    const llm = llmWith({ api_key_env: ENV_KEY });
    expect(() => resolveApiKey(llm)).toThrow(LlmCompletionError);
    expect(() => resolveApiKey(llm)).toThrow(
      "required env LITELLM_MASTER_KEY not set (source: llm.api_key_env)",
    );
  });

  it("12. throws when env set but empty / whitespace", () => {
    process.env[ENV_KEY] = "   ";
    const llm = llmWith({ api_key_env: ENV_KEY });
    expect(() => resolveApiKey(llm)).toThrow(LlmCompletionError);
  });
});