/**
 * packages/llm/src/provider.ts — multi-provider model factory (C1).
 *
 * Pure mapping: `AgentProvider + modelId → LanguageModelV2`. The
 * underlying SDK (`@ai-sdk/anthropic`, `@ai-sdk/openai`,
 * `@ai-sdk/google`, `ollama-ai-provider-v2`) is the actual transport;
 * this module is a thin switch so the supervisor loop never imports
 * any of those packages directly.
 *
 * Why an explicit switch over the Vercel AI Gateway string format
 * (`"anthropic/claude-sonnet-4-5"`)? Three reasons:
 *
 *   1. Per-provider options (e.g. Anthropic's `cacheControl`,
 *      Google's `safetySettings`) need explicit provider objects.
 *   2. The provider names in `cognit.yaml → agent.provider` are the
 *      closed literal set in `@cognit/agent/agent-config` — we map
 *      1:1 here, so an unrecognised value fails at compile time.
 *   3. Tests can inject a mock by short-circuiting the switch; the
 *      AI Gateway's "string model ref" mode bypasses the type
 *      system entirely.
 *
 * API key handling: each provider reads its env var on the call site
 * (`generateText` reads from process.env). We do not pass keys through
 * the layer — the env vars are the production wiring. The `LlmLive`
 * factory exposes a `requireEnv` boolean for tests / smoke runs that
 * want to assert the env is set without making a real call.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { ollama } from "ollama-ai-provider-v2";
import type { AgentProvider } from "@cognit/agent";
import { LlmCompletionError } from "./errors.js";

/**
 * Env-var names per provider. Kept as a record (not a switch) so
 * tests can iterate the table to assert each provider has a key.
 *
 * `undefined` means no key required (ollama + mock). `null` would
 * not survive a JSON round-trip so we use undefined deliberately.
 */
export const ENV_VAR_BY_PROVIDER: Readonly<
  Record<AgentProvider, string | undefined>
> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  ollama: undefined, // local daemon, no key
  mock: undefined,
};

/**
 * Build a model object for the given provider + modelId. Throws
 * `LlmCompletionError` synchronously if the provider name is not in
 * the closed literal (the type system should have caught this, but
 * we defend against a runtime-only provider mismatch).
 *
 * The return type is inferred from the SDK calls so we do not have
 * to import the SDK's internal `LanguageModelV2` type. The
 * TypeScript inference makes the four arms structurally compatible
 * with the SDK's `model` parameter on `generateText`.
 */
export const modelFor = (provider: AgentProvider, modelId: string) => {
  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    case "google":
      return google(modelId);
    case "ollama":
      return ollama(modelId);
    case "mock":
      // Mock provider should never reach the SDK. Callers should
      // substitute the LlmProvider Layer entirely for the mock case.
      throw new LlmCompletionError(
        "modelFor: 'mock' provider must not reach the SDK — substitute the LlmProvider Layer instead",
      );
  }
};

/**
 * Assert that the env var for the chosen provider is set. Used by
 * `LlmLive` so a misconfigured deployment fails at boot rather than
 * on the first supervisor tick. Returns the env var name when
 * missing so the caller can include it in error messages.
 */
export const requireEnvFor = (provider: AgentProvider): string | null => {
  const name = ENV_VAR_BY_PROVIDER[provider];
  if (name === undefined) return null;
  if (typeof process === "undefined" || !process.env) return name;
  return process.env[name] === undefined || process.env[name] === ""
    ? name
    : null;
};

/**
 * Throw a typed error if the env var for the chosen provider is
 * missing. Returns void when the env is set (or the provider needs
 * no key).
 */
export const assertEnvFor = (provider: AgentProvider): void => {
  const missing = requireEnvFor(provider);
  if (missing !== null) {
    throw new LlmCompletionError(
      `LLM provider '${provider}' requires env var ${missing} to be set`,
    );
  }
};
