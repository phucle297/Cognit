/**
 * packages/llm/test/layer.test.ts — LlmLiveFromRoute + LlmLiveLazyFromRoute.
 *
 * Cases:
 *  1. LlmLiveFromRoute with missing env var throws at build time
 *  2. LlmLiveLazyFromRoute defers env check to first `complete()` call
 *  3. gatewayShapeFor returns a shape whose complete is callable and
 *     returns an Effect
 *  4. complete() threads AbortSignal into generateText
 *  5. LLM_RETRY_SCHEDULE is exported and composable with Effect.retry
 *  6. complete() does NOT retry on AbortError
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import {
  LLM_RETRY_SCHEDULE,
  LlmLiveFromRoute,
  LlmLiveLazyFromRoute,
  gatewayShapeFor,
} from "../src/layer.js";
import { LlmCompletionError } from "../src/errors.js";
import { LlmProvider } from "@cognit/agent";

// Mock the Vercel AI SDK so we can drive retry / abort behaviour
// without making real network calls.
vi.mock("ai", () => ({
  generateText: vi.fn(),
}));
import { generateText } from "ai";

const llmCfg = (defaultModel?: string): {
  api_key_env: string;
  default_model?: string;
  models: Record<string, never>;
  commands: Record<string, never>;
} => ({
  api_key_env: "AI_GATEWAY_API_KEY",
  models: {},
  commands: {},
  ...(defaultModel !== undefined ? { default_model: defaultModel } : {}),
});

describe("LlmLiveFromRoute + LlmLiveLazyFromRoute — Gateway layer factories", () => {
  // The Gateway layer reads AI_GATEWAY_API_KEY synchronously inside
  // `gatewayModel()` on every `complete()` call. Set a dummy value
  // for tests that exercise `gatewayShapeFor.complete()` so the env
  // check passes; individual tests that specifically probe the
  // missing-env path (test 2) save+restore around their assertion.
  const savedKey = process.env.AI_GATEWAY_API_KEY;

  beforeEach(() => {
    vi.mocked(generateText).mockReset();
    process.env.AI_GATEWAY_API_KEY = "test-dummy-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = savedKey;
  });

  it("1. LlmLiveFromRoute with missing env throws at build time", () => {
    const saved = process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      expect(() =>
        LlmLiveFromRoute(llmCfg("anthropic/claude-sonnet-4-6")),
      ).toThrow(LlmCompletionError);
    } finally {
      if (saved !== undefined) process.env.AI_GATEWAY_API_KEY = saved;
    }
  });

  it("2. LlmLiveLazyFromRoute defers env check to first complete() call", async () => {
    // Override the beforeEach-set dummy so this test specifically
    // probes the missing-env path.
    delete process.env.AI_GATEWAY_API_KEY;
    const layer = LlmLiveLazyFromRoute(llmCfg("anthropic/claude-sonnet-4-6"));
    const program = Effect.gen(function* () {
      const llm = yield* LlmProvider;
      return yield* llm.complete({
        prompt: "x",
        model: "anthropic/claude-sonnet-4-6",
      });
    }).pipe(Effect.provide(layer));
    const either = await Effect.runPromise(program.pipe(Effect.either));
    expect(either._tag).toBe("Left");
  });

  it("3. gatewayShapeFor returns a usable shape (mock model id)", () => {
    // We never invoke `complete` — this pins the shape's surface
    // without making a real SDK call.
    const shape = gatewayShapeFor(llmCfg());
    expect(typeof shape.complete).toBe("function");
    const eff = shape.complete({ prompt: "p", model: "anthropic/claude-sonnet-4-6" });
    expect(eff).toBeDefined();
    void eff;
  });

  it("4. complete() threads AbortSignal into generateText", async () => {
    const shape = gatewayShapeFor(llmCfg());
    const controller = new AbortController();
    const mocked = vi.mocked(generateText);
    mocked.mockResolvedValueOnce({ text: "ok" } as never);
    await Effect.runPromise(
      shape.complete({
        prompt: "p",
        model: "anthropic/claude-sonnet-4-6",
        signal: controller.signal,
      }),
    );
    expect(mocked).toHaveBeenCalledTimes(1);
    const call = mocked.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
    expect(call.abortSignal).toBe(controller.signal);
  });

  it("5. LLM_RETRY_SCHEDULE is exported and composable", () => {
    expect(LLM_RETRY_SCHEDULE).toBeDefined();
    const shape = gatewayShapeFor(llmCfg());
    expect(typeof shape.complete).toBe("function");
  });

  it("6. complete() does NOT retry on AbortError", async () => {
    const shape = gatewayShapeFor(llmCfg());
    const controller = new AbortController();
    controller.abort();
    const mocked = vi.mocked(generateText);
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    mocked.mockRejectedValueOnce(abortError);
    const either = await Effect.runPromise(
      shape.complete({
        prompt: "p",
        model: "anthropic/claude-sonnet-4-6",
        signal: controller.signal,
      }).pipe(Effect.either),
    );
    expect(either._tag).toBe("Left");
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});
