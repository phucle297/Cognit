/**
 * packages/llm/src/openai.ts — OpenAI-compatible HTTP completion (C1).
 *
 * Plain `fetch` against `cfg.base_url + "/v1/chat/completions"`. No
 * SDK dependency. Used as the request transport for the LiteLLM
 * proxy (and any other OpenAI-compatible endpoint the operator
 * points `llm.base_url` at).
 *
 * Why not the Vercel AI SDK: the SDK adds model-id translation,
 * tool-call schema layers, and a stream abstraction we don't need.
 * A direct `fetch` keeps the wire surface transparent and removes
 * one major version-pin from `packages/llm/package.json`.
 *
 * Env-key handling: the API key is read inside the closure from
 * `process.env[cfg.api_key_env]`. `openaiComplete(cfg)` is called
 * once at layer build time; the resulting function reads the env
 * on every `complete()` call so a key rotated mid-process is picked
 * up without rebuilding the layer.
 *
 * Cancellation: the caller's `AbortSignal` is composed with a
 * per-request timeout (`AbortSignal.timeout(cfg.timeout_ms)`) via
 * `AbortSignal.any`. Either signal aborts the fetch.
 */

import { LlmCompletionError } from "./errors.js";
import type { LlmConfig } from "@cognit/core";

export interface OpenAiCompleteInput {
  prompt: string;
  model: string;
  signal?: AbortSignal;
}

export const openaiComplete = (cfg: LlmConfig) =>
  async ({ prompt, model, signal }: OpenAiCompleteInput): Promise<string> => {
    const raw = process.env[cfg.api_key_env];
    const apiKey = typeof raw === "string" ? raw.trim() : "";
    if (apiKey === "") {
      throw new LlmCompletionError(
        "required env " + cfg.api_key_env + " not set (model " + model + ", format: openai)"
      );
    }
    const timeoutSignal = AbortSignal.timeout(cfg.timeout_ms);
    const composed = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const res = await fetch(cfg.base_url + "/v1/chat/completions", {
      method: "POST",
      signal: composed,
      headers: {
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LlmCompletionError(
        "openai-compat: " + res.status + " " + res.statusText + " :: " + text.slice(0, 500)
      );
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content === "") {
      throw new LlmCompletionError("openai-compat: empty or malformed response (model " + model + ")");
    }
    return content;
  };