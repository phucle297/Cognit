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
    // Every keyed provider must point at either a string or a
    // non-empty string-array of env vars (Google accepts both the
    // canonical name and an alias).
    for (const p of KEYED) {
      const v = ENV_VAR_BY_PROVIDER[p];
      const ok =
        typeof v === "string" ||
        (Array.isArray(v) && v.every((n) => typeof n === "string"));
      expect(ok).toBe(true);
    }
    for (const p of UNKEYED) {
      expect(ENV_VAR_BY_PROVIDER[p]).toBeUndefined();
    }
    expect(ENV_VAR_BY_PROVIDER.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(ENV_VAR_BY_PROVIDER.openai).toBe("OPENAI_API_KEY");
    // Google accepts both names; canonical first.
    expect(ENV_VAR_BY_PROVIDER.google).toEqual([
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GOOGLE_API_KEY",
    ]);
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

  it("6b. GOOGLE_API_KEY alias is accepted when canonical is missing", () => {
    // Clear both Google envs, then set only the alias. requireEnvFor
    // must return null (env present) and assertEnvFor must not throw.
    const savedCanonical = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const savedAlias = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    process.env.GOOGLE_API_KEY = "alias-key";
    try {
      expect(requireEnvFor("google")).toBeNull();
      expect(() => assertEnvFor("google")).not.toThrow();
    } finally {
      if (savedCanonical !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = savedCanonical;
      else delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (savedAlias !== undefined) process.env.GOOGLE_API_KEY = savedAlias;
      else delete process.env.GOOGLE_API_KEY;
    }
  });

  it("6c. whitespace-only env var is treated as missing", () => {
    // A key set to "   " should NOT count as present — the user
    // probably typoed and the SDK would fail downstream anyway.
    const savedCanonical = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const savedAlias = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "   ";
    delete process.env.GOOGLE_API_KEY;
    try {
      expect(requireEnvFor("google")).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
    } finally {
      if (savedCanonical !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = savedCanonical;
      else delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (savedAlias !== undefined) process.env.GOOGLE_API_KEY = savedAlias;
      else delete process.env.GOOGLE_API_KEY;
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
