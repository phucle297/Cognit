/**
 * packages/agent/test/agent-config.test.ts — AgentConfig schema.
 *
 * Cases:
 *   1. `parseAgentConfig({})` defaults model to "mock-1"
 *   2. `parseAgentConfig({ model: "anthropic/claude-sonnet-4-6" })` preserves full Gateway id
 *   3. empty model string rejected by minLength(1)
 *   4. `defaultAgentConfig.model` is "mock-1"
 *   5. max_actions_per_tick defaults to 5, accepts 0 for rank-only ticks
 *   6. max_prompt_hypotheses defaults to 50, requires positive int
 */
import { describe, it, expect } from "vitest";
import {
  parseAgentConfig,
  defaultAgentConfig,
} from "../src/agent-config.js";

describe("AgentConfig — model-only schema (post --provider removal)", () => {
  it("1. parseAgentConfig({}) defaults model to 'mock-1'", () => {
    const cfg = parseAgentConfig({});
    expect(cfg.model).toBe("mock-1");
  });

  it("2. parseAgentConfig({ model: 'anthropic/claude-sonnet-4-6' }) preserves full Gateway id", () => {
    const cfg = parseAgentConfig({ model: "anthropic/claude-sonnet-4-6" });
    expect(cfg.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("3. empty model string rejected by minLength(1)", () => {
    expect(() => parseAgentConfig({ model: "" })).toThrow();
  });

  it("4. defaultAgentConfig.model is 'mock-1'", () => {
    expect(defaultAgentConfig.model).toBe("mock-1");
  });

  it("5. max_actions_per_tick defaults to 5 and accepts 0 (rank-only ticks)", () => {
    expect(parseAgentConfig({}).max_actions_per_tick).toBe(5);
    expect(parseAgentConfig({ max_actions_per_tick: 0 }).max_actions_per_tick).toBe(0);
  });

  it("6. max_prompt_hypotheses defaults to 50 and requires positive int", () => {
    expect(parseAgentConfig({}).max_prompt_hypotheses).toBe(50);
    expect(() => parseAgentConfig({ max_prompt_hypotheses: 0 })).toThrow();
  });
});
