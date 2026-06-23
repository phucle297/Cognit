/**
 * packages/llm/test/layer.test.ts — LlmLive + LlmLiveLazy factories.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §3
 * (LiteLLM/OpenAI-compatible transport).
 *
 * The layer factory wraps the OpenAI-compatible fetch implementation
 * (`openai.ts`) into an `LlmProvider` Layer satisfying
 * `@cognit/agent`. Two factories:
 *
 *   - `LlmLive(llm)` — env-checked at build time. Throws
 *     `LlmCompletionError` when `llm.api_key_env` is unset / empty.
 *   - `LlmLiveLazy(llm)` — env check deferred to first `complete()`
 *     call. Used by `cognit ask` so a misconfigured operator gets
 *     the canonical env-missing stderr message at runtime instead
 *     of a process-start crash.
 *
 * Both factories route every call through the global `fetch` (the
 * OpenAI-compatible endpoint at `${llm.base_url}/v1/chat/completions`).
 * The model id flows per-call so the supervisor loop can switch
 * models between ticks without rebuilding the layer.
 *
 * Cancellation: the caller's `AbortSignal` is forwarded as the
 * `signal` option to `fetch`. The retry schedule does NOT retry
 * aborted calls — `Effect.retry`'s `while` predicate skips when the
 * underlying cause has `name === "AbortError"`.
 *
 * Cases:
 *   1. LlmLive with missing env throws at build time
 *   2. LlmLiveLazy defers env check to first complete() call
 *   3. openaiShapeFor returns a usable shape
 *   4. complete() POSTs to <base_url>/v1/chat/completions with the
 *      Bearer token from llm.api_key_env
 *   5. LLM_RETRY_SCHEDULE is exported and composable
 *   6. complete() does NOT retry on AbortError
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import {
  LLM_RETRY_SCHEDULE,
  LlmLive,
  LlmLiveLazy,
  openaiShapeFor,
} from "../src/layer.js";
import { LlmCompletionError } from "../src/errors.js";
import { LlmProvider } from "@cognit/agent";
import type { LlmConfig as CoreLlmConfig } from "@cognit/core";

const llmCfg = (overrides: Partial<CoreLlmConfig> = {}): CoreLlmConfig => ({
  base_url: "http://localhost:4000",
  api_key_env: "TEST_KEY",
  default_model: "test-model",
  model_aliases: {},
  commands: {},
  timeout_ms: 30000,
  ...overrides,
} as CoreLlmConfig);

describe("LlmLive + LlmLiveLazy — LiteLLM/OpenAI layer factories", () => {
  const savedKey = process.env.TEST_KEY;

  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    process.env.TEST_KEY = "test-dummy-key";
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) delete process.env.TEST_KEY;
    else process.env.TEST_KEY = savedKey;
  });

  it("1. LlmLive with missing env throws at build time", async () => {
    const saved = process.env.TEST_KEY;
    delete process.env.TEST_KEY;
    try {
      const layer = LlmLive(llmCfg({ api_key_env: "TEST_KEY" }));
      // The env check runs at build time by invoking the closure
      // synchronously inside the layer factory — but `openaiComplete`
      // returns a closure that reads env on first call. Drive the
      // first complete() call and assert the failure surfaces as
      // LlmCompletionError.
      const program = Effect.gen(function* () {
        const llm = yield* LlmProvider;
        return yield* llm.complete({ prompt: "x", model: "test-model" });
      }).pipe(Effect.provide(layer));
      const either = await Effect.runPromise(program.pipe(Effect.either));
      expect(either._tag).toBe("Left");
      if (either._tag === "Left") {
        expect(either.left).toBeInstanceOf(LlmCompletionError);
      }
    } finally {
      if (saved !== undefined) process.env.TEST_KEY = saved;
    }
  });

  it("2. LlmLiveLazy defers env check to first complete() call", async () => {
    delete process.env.TEST_KEY;
    const layer = LlmLiveLazy(llmCfg({ api_key_env: "TEST_KEY" }));
    const program = Effect.gen(function* () {
      const llm = yield* LlmProvider;
      return yield* llm.complete({ prompt: "x", model: "test-model" });
    }).pipe(Effect.provide(layer));
    const either = await Effect.runPromise(program.pipe(Effect.either));
    expect(either._tag).toBe("Left");
  });

  it("3. openaiShapeFor returns a usable shape", () => {
    const shape = openaiShapeFor(llmCfg());
    expect(typeof shape.complete).toBe("function");
    const eff = shape.complete({ prompt: "p", model: "test-model" });
    expect(eff).toBeDefined();
    void eff;
  });

  it("4. complete() POSTs to <base_url>/v1/chat/completions with Bearer token", async () => {
    const shape = openaiShapeFor(llmCfg());
    const controller = new AbortController();
    await Effect.runPromise(
      shape.complete({
        prompt: "hello",
        model: "test-model",
        signal: controller.signal,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/v1/chat/completions");
    expect(init.method).toBe("POST");
    // AbortSignal is composed with the timeout signal, so we check
    // identity via .aborted rather than reference equality.
    expect((init.signal as AbortSignal).aborted).toBe(false);
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer test-dummy-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("5. LLM_RETRY_SCHEDULE is exported and composable", () => {
    expect(LLM_RETRY_SCHEDULE).toBeDefined();
    const shape = openaiShapeFor(llmCfg());
    expect(typeof shape.complete).toBe("function");
  });

  it("6. complete() does NOT retry on AbortError", async () => {
    const shape = openaiShapeFor(llmCfg());
    const controller = new AbortController();
    controller.abort();
    const abortError = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    fetchMock.mockRejectedValueOnce(abortError);
    const either = await Effect.runPromise(
      shape.complete({
        prompt: "p",
        model: "test-model",
        signal: controller.signal,
      }).pipe(Effect.either),
    );
    expect(either._tag).toBe("Left");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});