/**
 * packages/llm/test/provider.test.ts — multi-provider model factory.
 *
 * Cases:
 *  1. ENV_VAR_BY_PROVIDER table maps every provider to the right env var
 *  2. requireEnvFor returns the env name when key is missing
 *  3. requireEnvFor returns null when key is set
 *  4. requireEnvFor returns null for ollama + mock (no key needed)
 *  5. assertEnvFor throws LlmCompletionError when env missing
 *  6. assertEnvFor is silent when env set
 *  7. modelFor: each provider returns an SDK model object (truthy,
 *     callable as `provider(modelId)`)
 *  8. modelFor('mock', ...) throws LlmCompletionError
 */
import { describe, it, expect } from "vitest";
import {
  ENV_VAR_BY_PROVIDER,
  assertEnvFor,
  modelFor,
  requireEnvFor,
} from "../src/provider.js";
import { LlmCompletionError } from "../src/errors.js";
import type { AgentProvider } from "@cognit/agent";

const KEYED: ReadonlyArray<AgentProvider> = ["anthropic", "openai", "google"];
const UNKEYED: ReadonlyArray<AgentProvider> = ["ollama", "mock"];

describe("provider — env-var surface", () => {
  it("1. ENV_VAR_BY_PROVIDER table covers every AgentProvider", () => {
    for (const p of KEYED) {
      expect(ENV_VAR_BY_PROVIDER[p]).toBeTypeOf("string");
    }
    for (const p of UNKEYED) {
      expect(ENV_VAR_BY_PROVIDER[p]).toBeUndefined();
    }
    expect(ENV_VAR_BY_PROVIDER.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(ENV_VAR_BY_PROVIDER.openai).toBe("OPENAI_API_KEY");
    expect(ENV_VAR_BY_PROVIDER.google).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
  });

  it("2. requireEnvFor returns the env name when key is missing", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(requireEnvFor("anthropic")).toBe("ANTHROPIC_API_KEY");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("3. requireEnvFor returns null when key is set", () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      expect(requireEnvFor("openai")).toBeNull();
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it("4. requireEnvFor returns null for ollama + mock (no key)", () => {
    for (const p of UNKEYED) {
      expect(requireEnvFor(p)).toBeNull();
    }
  });

  it("5. assertEnvFor throws LlmCompletionError when env missing", () => {
    const saved = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    try {
      expect(() => assertEnvFor("google")).toThrow(LlmCompletionError);
    } finally {
      if (saved !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = saved;
    }
  });

  it("6. assertEnvFor is silent when env set", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      expect(() => assertEnvFor("anthropic")).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("provider — modelFor", () => {
  it("7. each provider returns a non-null SDK model object", () => {
    // We do NOT make a real SDK call. modelFor just constructs the
    // provider's model-reference function (or in ollama's case, the
    // configured provider object). Truthy is enough — the actual
    // SDK call happens inside generateText, which we never invoke.
    for (const p of ["anthropic", "openai", "google", "ollama"] as const) {
      const m = modelFor(p, "test-model");
      expect(m).toBeDefined();
      expect(m).not.toBeNull();
    }
  });

  it("8. modelFor('mock', ...) throws LlmCompletionError", () => {
    expect(() => modelFor("mock", "x")).toThrow(LlmCompletionError);
  });
});
