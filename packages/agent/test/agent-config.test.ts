/**
 * packages/agent/test/agent-config.test.ts — relaxed AgentConfig schema.
 *
 * Cognit-l06/005 relaxed `AgentConfig.provider` to truly optional
 * (no implicit `"mock"` default). Spec §4. The literal
 * `AgentProvider` stays exported for the `--provider` back-compat
 * grace period.
 *
 * Cases:
 *   1. `parseAgentConfig({})` no longer defaults provider to "mock"
 *   2. `parseAgentConfig({ provider: "mock" })` still works
 *   3. `parseAgentConfig({ provider: "anthropic" })` still works
 *   4. unknown provider rejected (literal unchanged)
 *   5. `defaultAgentConfig.provider` is "mock" (explicit, not schema-defaulted)
 *   6. AgentProvider literal still exported with the same union
 */
import { describe, it, expect } from "vitest";
import {
  AgentProvider,
  parseAgentConfig,
  defaultAgentConfig,
  type AgentConfig,
} from "../src/agent-config.js";

describe("AgentConfig — provider relaxation (Cognit-l06/005)", () => {
  it("1. parseAgentConfig({}) no longer defaults provider to 'mock'", () => {
    const cfg = parseAgentConfig({});
    expect(cfg.provider).toBeUndefined();
  });

  it("2. parseAgentConfig({ provider: 'mock' }) works", () => {
    const cfg = parseAgentConfig({ provider: "mock" });
    expect(cfg.provider).toBe("mock");
  });

  it("3. parseAgentConfig({ provider: 'anthropic' }) works", () => {
    const cfg = parseAgentConfig({ provider: "anthropic", model: "claude-3-haiku-20240307" });
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-3-haiku-20240307");
  });

  it("4. unknown provider rejected (literal union unchanged)", () => {
    expect(() => parseAgentConfig({ provider: "unknown" })).toThrow();
  });

  it("5. defaultAgentConfig.provider is 'mock' (explicit, not schema-defaulted)", () => {
    expect(defaultAgentConfig.provider).toBe("mock");
  });

  it("6. AgentProvider literal still exported with the same union", () => {
    // Type-level: the literal accepts exactly these five strings.
    // Run-time: parseAgentConfig round-trips each one.
    const names: AgentProvider[] = ["anthropic", "openai", "google", "ollama", "mock"];
    for (const n of names) {
      const cfg = parseAgentConfig({ provider: n });
      expect(cfg.provider).toBe(n);
    }
    // Confirm export is the schema (so consumers can decode manually).
    expect(AgentProvider).toBeDefined();
  });
});
