/**
 * packages/llm/test/openai.test.ts — OpenAI-compatible fetch client.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §3
 * (LiteLLM/OpenAI-compatible transport).
 *
 * Wraps `global.fetch` to call `<base_url>/v1/chat/completions`
 * with an `Authorization: Bearer <key>` header. Returns
 * `choices[0].message.content`. Errors are typed as
 * `LlmCompletionError` with the exact env var / status attached.
 *
 * `openaiComplete(cfg)` returns a curried async function that takes
 * `{ prompt, model, signal? }`. This is a plain Promise — no
 * Effect wrapping at this layer. The retry + abort-skip is applied
 * by `LlmLive` in `layer.ts`.
 *
 * Cases:
 *   1. happy path: fetch 200 + choices[0].message.content → returns string
 *   2. missing env: throws LlmCompletionError with env var name
 *   3. non-2xx (500): throws LlmCompletionError with status
 *   4. malformed (no choices): throws LlmCompletionError
 *   5. abort: signal aborted → throws
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openaiComplete, type OpenAiCompleteInput } from "../src/openai.js";
import { LlmCompletionError } from "../src/errors.js";
import type { LlmConfig } from "@cognit/core";

const llmCfg = (overrides: Partial<LlmConfig> = {}): LlmConfig => ({
  base_url: "http://localhost:4000",
  api_key_env: "TEST_KEY",
  default_model: "test-model",
  model_aliases: {},
  commands: {},
  timeout_ms: 30000,
  ...overrides,
} as LlmConfig);

const jsonResponse = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

const errorResponse = (status: number) => ({
  ok: false,
  status,
  statusText: "Internal Server Error",
  text: async () => "boom",
  json: async () => ({}),
});

const inputOf = (overrides: Partial<OpenAiCompleteInput> = {}): OpenAiCompleteInput => ({
  prompt: "hi",
  model: "test-model",
  ...overrides,
});

describe("openaiComplete — OpenAI-compatible fetch client", () => {
  const savedKey = process.env.TEST_KEY;

  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    process.env.TEST_KEY = "sk-test";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) delete process.env.TEST_KEY;
    else process.env.TEST_KEY = savedKey;
  });

  it("1. happy path: 200 + choices[0].message.content → returns string", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse("hello world"));
    const complete = openaiComplete(llmCfg());
    const result = await complete(inputOf({ prompt: "hi" }));
    expect(result).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("2. missing env: throws LlmCompletionError with env var name", async () => {
    delete process.env.TEST_KEY;
    const complete = openaiComplete(llmCfg());
    await expect(complete(inputOf())).rejects.toBeInstanceOf(LlmCompletionError);
    await expect(complete(inputOf())).rejects.toThrow(/TEST_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("3. non-2xx (500): throws LlmCompletionError with status", async () => {
    fetchMock.mockResolvedValue(errorResponse(500));
    const complete = openaiComplete(llmCfg());
    await expect(complete(inputOf())).rejects.toBeInstanceOf(LlmCompletionError);
    await expect(complete(inputOf())).rejects.toThrow(/500/);
  });

  it("4. malformed (no choices): throws LlmCompletionError", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const complete = openaiComplete(llmCfg());
    await expect(complete(inputOf())).rejects.toBeInstanceOf(LlmCompletionError);
  });

  it("5. abort: signal aborted → throws", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    fetchMock.mockRejectedValueOnce(abortError);
    const complete = openaiComplete(llmCfg());
    // The raw openaiComplete does not wrap AbortError — it propagates
    // the underlying DOMException. Layer.ts wraps it as
    // LlmCompletionError when consumed via LlmLive (covered in
    // layer.test.ts:6). Here we assert the abort propagates.
    await expect(
      complete(inputOf({ signal: controller.signal })),
    ).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});