/**
 * packages/llm/test/resolve-model.test.ts — pure alias resolver.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §2
 * (resolution order).
 *
 * `resolveModel(llm, command)` picks a model id for a given CLI
 * command. Resolution order (after CLI flag, which lives in
 * `apps/cli/src/config-resolver.ts`, not here):
 *
 *   1. `llm.commands[command].model` if set + non-empty (literal)
 *   2. `llm.commands[command].alias` looked up in `llm.model_aliases`
 *   3. `llm.model_aliases[command]` fallback (e.g. when commands
 *      block is absent but `model_aliases.quick` is set globally)
 *   4. `llm.default_model`
 *
 * Pure function — no process I/O.
 *
 * Cases:
 *   1. commands.ask.alias="quick", model_aliases.quick="gpt-5" → "gpt-5"
 *   2. commands.ask.alias="quick", model_aliases missing → default_model
 *   3. commands.ask.model="foo" → "foo"
 *   4. no commands → default_model
 */
import { describe, it, expect } from "vitest";
import { resolveModel } from "../src/resolve-model.js";
import type { LlmConfig } from "@cognit/core";

const llmCfg = (overrides: Partial<LlmConfig> = {}): LlmConfig => ({
  base_url: "http://localhost:4000",
  api_key_env: "TEST_KEY",
  default_model: "default-model",
  model_aliases: {},
  commands: {},
  ...overrides,
} as LlmConfig);

describe("resolveModel — alias + commands resolution", () => {
  it("1. commands.ask.alias resolved via model_aliases", () => {
    const llm = llmCfg({
      commands: { ask: { alias: "quick" } },
      model_aliases: { quick: "gpt-5" },
    });
    expect(resolveModel(llm, "ask")).toBe("gpt-5");
  });

  it("2. commands.ask.alias without model_aliases entry → default_model", () => {
    const llm = llmCfg({
      commands: { ask: { alias: "quick" } },
      model_aliases: {},
    });
    expect(resolveModel(llm, "ask")).toBe("default-model");
  });

  it("3. commands.ask.model (literal) takes precedence over alias", () => {
    const llm = llmCfg({
      commands: { ask: { model: "foo" } },
      model_aliases: { foo: "gpt-5" },
    });
    expect(resolveModel(llm, "ask")).toBe("foo");
  });

  it("4. no commands block → default_model", () => {
    const llm = llmCfg({ commands: {} });
    expect(resolveModel(llm, "ask")).toBe("default-model");
  });
});