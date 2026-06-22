/**
 * packages/llm/test/json.test.ts — JSON completion + Effect Schema validation.
 *
 * Cases:
 *  1. completeJson returns parsed object when LLM emits valid JSON
 *     matching schema
 *  2. completeJson wraps prompt with JSON_OUTPUT_INSTRUCTION (golden)
 *  3. completeJson fails with JsonParseError when output is not JSON
 *  4. completeJson fails with SchemaValidationError when JSON is
 *     valid but does not match schema
 *  5. completeJson propagates LlmCompletionError from underlying call
 *  6. completeJson with deeply nested schema validates recursively
 *  7. completeJson with empty object {} decodes as {}
 *  8. completeJson with array schema decodes an array
 *  9. extendWithJson attaches completeJson without dropping complete
 * 10. JSON_OUTPUT_INSTRUCTION constant is exactly the expected text
 *     (changing it changes model behaviour; pin it)
 * 11. raw > MAX_RAW_BYTES → JsonParseError with truncated raw
 * 12. signal is forwarded to underlying complete()
 */
import { describe, it, expect } from "vitest";
import { Effect, Schema } from "effect";
import {
  JSON_OUTPUT_INSTRUCTION,
  MAX_RAW_BYTES,
  RAW_TRUNCATE_BYTES,
  extendWithJson,
  makeCompleteJson,
} from "../src/json.js";
import {
  JsonParseError,
  LlmCompletionError,
  SchemaValidationError,
} from "../src/errors.js";
import type { LlmProviderShape } from "@cognit/agent";

const mkShape = (complete: LlmProviderShape["complete"]): LlmProviderShape => ({
  complete,
});

const Person = Schema.Struct({
  name: Schema.String,
  age: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
});

const Nested = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    tags: Schema.Array(Schema.String),
  }),
});

describe("completeJson — JSON completion + schema validation", () => {
  it("1. valid JSON + valid schema → returns parsed object", async () => {
    const shape = mkShape(() => Effect.succeed('{"name":"alice","age":30}'));
    const result = await Effect.runPromise(
      makeCompleteJson(shape.complete)({
        prompt: "p",
        model: "m",
        provider: "anthropic",
        schema: Person,
      }),
    );
    expect(result.name).toBe("alice");
    expect(result.age).toBe(30);
  });

  it("2. prompt is wrapped with JSON_OUTPUT_INSTRUCTION", async () => {
    let capturedPrompt = "";
    const shape = mkShape(({ prompt }) => {
      capturedPrompt = prompt;
      return Effect.succeed('{"name":"a","age":1}');
    });
    await Effect.runPromise(
      makeCompleteJson(shape.complete)({
        prompt: "describe person",
        model: "m",
        provider: "anthropic",
        schema: Person,
      }),
    );
    expect(capturedPrompt).toBe("describe person" + JSON_OUTPUT_INSTRUCTION);
  });

  it("3. non-JSON output → JsonParseError (raw text attached)", async () => {
    const shape = mkShape(() => Effect.succeed("Sure! Here you go:"));
    const either = await Effect.runPromise(
      makeCompleteJson(shape.complete)({
        prompt: "p",
        model: "m",
        provider: "anthropic",
        schema: Person,
      }).pipe(Effect.either),
    );
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(either.left).toBeInstanceOf(JsonParseError);
      expect((either.left as JsonParseError).raw).toBe("Sure! Here you go:");
    }
  });

  it("4. valid JSON, schema mismatch → SchemaValidationError", async () => {
    const shape = mkShape(() => Effect.succeed('{"name":"a","age":"thirty"}'));
    const either = await Effect.runPromise(
      makeCompleteJson(shape.complete)({
        prompt: "p",
        model: "m",
        provider: "anthropic",
        schema: Person,
      }).pipe(Effect.either),
    );
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(either.left).toBeInstanceOf(SchemaValidationError);
      const e = either.left as SchemaValidationError;
      expect(e.raw).toBe('{"name":"a","age":"thirty"}');
      expect(e.issues).toBeTruthy();
    }
  });

  it("5. underlying LlmCompletionError propagates", async () => {
    const shape = mkShape(() =>
      Effect.fail(new LlmCompletionError("network down")),
    );
    const either = await Effect.runPromise(
      makeCompleteJson(shape.complete)({
        prompt: "p",
        model: "m",
        provider: "anthropic",
        schema: Person,
      }).pipe(Effect.either),
    );
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(either.left).toBeInstanceOf(LlmCompletionError);
      expect((either.left as LlmCompletionError).message).toBe("network down");
    }
  });

  it("6. deeply nested schema validates recursively", async () => {
    const shape = mkShape(() =>
      Effect.succeed('{"user":{"id":"u-1","tags":["a","b"]}}'),
    );
    const result = await Effect.runPromise(
      makeCompleteJson(shape.complete)({
        prompt: "p",
        model: "m",
        provider: "anthropic",
        schema: Nested,
      }),
    );
    expect(result.user.id).toBe("u-1");
    expect(result.user.tags).toEqual(["a", "b"]);
  });

  it("7. empty object {} decodes as {}", async () => {
    const Empty = Schema.Struct({});
    const shape = mkShape(() => Effect.succeed("{}"));
    const result = await Effect.runPromise(
      makeCompleteJson(shape.complete)({
        prompt: "p",
        model: "m",
        provider: "anthropic",
        schema: Empty,
      }),
    );
    expect(result).toEqual({});
  });

  it("8. array schema decodes an array", async () => {
    const NumList = Schema.Array(Schema.Number);
    const shape = mkShape(() => Effect.succeed("[1, 2, 3]"));
    const result = await Effect.runPromise(
      makeCompleteJson(shape.complete)({
        prompt: "p",
        model: "m",
        provider: "anthropic",
        schema: NumList,
      }),
    );
    expect(result).toEqual([1, 2, 3]);
  });

  it("9. extendWithJson attaches completeJson, preserves complete", async () => {
    let capturedPrompt = "";
    const base: LlmProviderShape = {
      complete: ({ prompt }) => {
        capturedPrompt = prompt;
        return Effect.succeed('{"name":"a","age":1}');
      },
    };
    const ext = extendWithJson(base);
    expect(ext.complete).toBe(base.complete);
    expect(typeof ext.completeJson).toBe("function");
    await Effect.runPromise(
      ext.completeJson({
        prompt: "p",
        model: "m",
        provider: "anthropic",
        schema: Person,
      }),
    );
    expect(capturedPrompt).toBe("p" + JSON_OUTPUT_INSTRUCTION);
  });

  it("10. JSON_OUTPUT_INSTRUCTION is pinned to the documented text", () => {
    expect(JSON_OUTPUT_INSTRUCTION).toBe(
      "\n\nReturn ONLY valid JSON matching the schema described above. " +
        "Do not wrap the response in markdown fences. Do not add commentary.",
    );
  });

  it("11. raw > MAX_RAW_BYTES → JsonParseError with truncated raw", async () => {
    // Mock complete returns a string well over 1MB. We never want
    // JSON.parse to run on it — the cap must reject first.
    const oversized = "x".repeat(MAX_RAW_BYTES + 1);
    const shape = mkShape(() => Effect.succeed(oversized));
    const either = await Effect.runPromise(
      makeCompleteJson(shape.complete)({
        prompt: "p",
        model: "m",
        provider: "anthropic",
        schema: Person,
      }).pipe(Effect.either),
    );
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(either.left).toBeInstanceOf(JsonParseError);
      const e = either.left as JsonParseError;
      // Truncated raw must be head + ellipsis, and must NOT be the
      // full oversized payload (that's the whole point of the cap).
      expect(e.raw.length).toBe(RAW_TRUNCATE_BYTES + 3);
      expect(e.raw.endsWith("...")).toBe(true);
      expect(e.raw.length).toBeLessThan(oversized.length);
    }
  });

  it("12. signal is forwarded to underlying complete()", async () => {
    let captured: AbortSignal | undefined;
    const shape = mkShape(({ signal }) => {
      captured = signal;
      return Effect.succeed('{"name":"a","age":1}');
    });
    const controller = new AbortController();
    await Effect.runPromise(
      makeCompleteJson(shape.complete)({
        prompt: "p",
        model: "m",
        provider: "anthropic",
        schema: Person,
        signal: controller.signal,
      }),
    );
    expect(captured).toBe(controller.signal);
  });
});
