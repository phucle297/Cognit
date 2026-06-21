/**
 * packages/llm/test/layer.test.ts — LlmLive + LlmLiveLazy factories.
 *
 * Cases:
 *  1. LlmLive with missing env var throws at build time
 *  2. LlmLiveLazy with missing env var succeeds at build, fails on
 *     first `complete()` call
 *  3. LlmLive with ollama provider (no key required) builds cleanly
 *  4. LlmLive with mock provider builds cleanly
 *  5. The built Layer yields an LlmProvider whose `complete` and
 *     `completeJson` are functions
 *  6. llmShapeFor returns a shape whose complete is callable and
 *     returns an Effect
 */
import { describe, it, expect } from "vitest";
import { Context, Effect, Layer } from "effect";
import {
  LlmLive,
  LlmLiveLazy,
  llmShapeFor,
} from "../src/layer.js";
import { LlmCompletionError } from "../src/errors.js";
import { LlmProvider } from "@cognit/agent";
import { defaultAgentConfig, parseAgentConfig } from "@cognit/agent";

describe("LlmLive + LlmLiveLazy — layer factories", () => {
  it("1. LlmLive with missing env throws at build time", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const cfg = parseAgentConfig({ provider: "anthropic", model: "claude-3-haiku-20240307" });
      expect(() => LlmLive(cfg)).toThrow(LlmCompletionError);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("2. LlmLiveLazy defers env check to first complete() call", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const cfg = parseAgentConfig({ provider: "anthropic", model: "claude-3-haiku-20240307" });
      const layer = LlmLiveLazy(cfg); // no throw at build
      const program = Effect.gen(function* () {
        const llm = yield* LlmProvider;
        return yield* llm.complete({ prompt: "x", model: "claude-3-haiku-20240307" });
      }).pipe(Effect.provide(layer));
      const either = await Effect.runPromise(program.pipe(Effect.either));
      // SDK call should fail with an SDK error wrapped in LlmCompletionError.
      // (We don't make a real call here — we just want to confirm the
      // failure path is reachable, not a specific message.)
      expect(either._tag).toBe("Left");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("3. LlmLive with ollama (no env var required) builds cleanly", () => {
    const cfg = parseAgentConfig({ provider: "ollama", model: "llama3.2" });
    expect(() => LlmLive(cfg)).not.toThrow();
  });

  it("4. LlmLive with mock provider builds cleanly", () => {
    const cfg = parseAgentConfig({ provider: "mock", model: "mock-1" });
    expect(() => LlmLive(cfg)).not.toThrow();
  });

  it("5. built Layer yields LlmProvider with complete + completeJson", async () => {
    const cfg = parseAgentConfig({ provider: "ollama", model: "llama3.2" });
    const layer = LlmLive(cfg);
    const program = Effect.gen(function* () {
      const llm = yield* LlmProvider;
      return {
        hasComplete: typeof llm.complete === "function",
        hasCompleteJson: typeof llm.completeJson === "function",
      };
    }).pipe(Effect.provide(layer));
    const out = await Effect.runPromise(program);
    expect(out.hasComplete).toBe(true);
    expect(out.hasCompleteJson).toBe(true);
  });

  it("6. llmShapeFor returns a usable shape (mock provider)", async () => {
    // We use the mock provider here. llmShapeFor wraps generateText
    // which would normally hit the SDK, but we never call complete().
    // This test pins the shape's surface without making a real call.
    const shape = llmShapeFor(defaultAgentConfig);
    expect(typeof shape.complete).toBe("function");
    const eff = shape.complete({ prompt: "p", model: "m" });
    expect(eff).toBeDefined();
    // Mock provider is handled by the SDK path here, so we don't
    // actually invoke it. We just verify the shape's API.
    void eff;
  });
});

// Suppress an unused-import warning for `Context` + `Layer` (kept for
// future use when wiring the Layer into a larger program).
void Context;
void Layer;
