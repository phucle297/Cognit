import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { makeRedactor, redactEvent, redactWithSpans } from "../src/redaction";
import { RedactionConfig, Redactor } from "../src/context";

describe("makeRedactor (built-in patterns)", () => {
  const r = makeRedactor();

  it("redacts a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = r.redact(`token=${jwt} seen`);
    expect(out).not.toContain("eyJhbGciOi");
    expect(out).toContain("[REDACTED:jwt]");
  });

  it("redacts an api_key_inline", () => {
    const out = r.redact(`api_key="abcdefghijklmnop1234"`);
    expect(out).not.toContain("abcdefghijklmnop1234");
    expect(out).toContain("[REDACTED:api_key]");
  });

  it("redacts a PEM block", () => {
    const out = r.redact(
      `before\n-----BEGIN RSA PRIVATE KEY-----\nABCDEF\n-----END RSA PRIVATE KEY-----\nafter`,
    );
    expect(out).toContain("[REDACTED:pem_block]");
    expect(out).not.toContain("ABCDEF");
  });

  it("redacts a password field", () => {
    const out = r.redact(`password=sup3rs3cret`);
    expect(out).toContain("[REDACTED:password]");
    expect(out).not.toContain("sup3rs3cret");
  });

  it("recursively redacts nested object values", () => {
    const out = r.redactValue({
      outer: { inner: "token=abcdefghijklmnop1234" },
      list: ['api_key="qrstuvwxyz1234567"', "safe text"],
    });
    expect(JSON.stringify(out)).not.toContain("abcdefghijklmnop1234");
    expect(JSON.stringify(out)).not.toContain("qrstuvwxyz1234567");
    expect(JSON.stringify(out)).toContain("[REDACTED:api_key]");
  });

  it("returns hit metadata without the redacted content", () => {
    const hits = r.scanValue({
      a: "token=abcdefghijklmnop1234",
      b: "safe",
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.pattern).toMatch(/^(jwt|api_key_inline|pem_block|password_field)$/);
      expect(h.fieldPath).toMatch(/^a$|^b$|^a\.|^b\./);
      // No content field on the hit shape.
      expect("content" in h).toBe(false);
    }
  });
});

describe("redactEvent (event-store boundary)", () => {
  const r = makeRedactor();
  it("redacts both payload and source, returning hits with field paths", () => {
    const result = redactEvent(
      { text: "token=abcdefghijklmnop1234" },
      { tool: "cli", command: "echo password=zzz", file_path: undefined },
      r,
    );
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.redactedPayload).not.toContain("abcdefghijklmnop1234");
    expect(result.redactedSource).not.toContain("zzz");
  });

  it("emits hits with non-empty fieldPath for top-level string payload", () => {
    const result = redactEvent("token=abcdefghijklmnop1234", undefined, r);
    expect(result.hits.length).toBeGreaterThan(0);
    for (const h of result.hits) {
      expect(h.fieldPath).toMatch(/^payload\./);
    }
  });

  it("emits hits with payload.<dotted.path> for nested object payload", () => {
    const result = redactEvent({ user: { token: "api_key=abcdefghijklmnop1234" } }, undefined, r);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((h) => h.fieldPath === "payload.value.user.token")).toBe(true);
  });

  it("emits hits with payload[i] for array values", () => {
    const result = redactEvent(
      { tokens: ["api_key=abcdefghijklmnop1234", "api_key=qrstuvwxyz1234567"] },
      undefined,
      r,
    );
    expect(result.hits.length).toBeGreaterThanOrEqual(2);
    expect(result.hits.some((h) => h.fieldPath === "payload.value.tokens[0]")).toBe(true);
    expect(result.hits.some((h) => h.fieldPath === "payload.value.tokens[1]")).toBe(true);
  });
});

describe("redactWithSpans (top-level helper)", () => {
  it("returns hits with correct [start, end) spans against the original text", () => {
    const text = "hello api_key=abcdefghijklmnop1234 and password=sup3rs3cret tail";
    const { hits, redacted } = redactWithSpans(text, [
      { name: "api_key_inline", regex: "(api_key)[\"']?\\s*[:=]\\s*[\"']?([A-Za-z0-9_-]{16,})", replacement: "$1=[REDACTED:api_key]" },
      { name: "password_field", regex: "(password)[\"']?\\s*[:=]\\s*[\"']?([^\\s\"',}{]+)", replacement: "$1=[REDACTED:password]" },
    ]);
    // The two matches should have the right spans.
    expect(hits).toHaveLength(2);
    const apiHit = hits.find((h) => h.pattern === "api_key_inline")!;
    const pwdHit = hits.find((h) => h.pattern === "password_field")!;
    expect(apiHit.span).toEqual([text.indexOf("api_key="), text.indexOf("api_key=") + apiHit.match.length]);
    expect(apiHit.match).toBe("api_key=abcdefghijklmnop1234");
    expect(text.slice(apiHit.span[0], apiHit.span[1])).toBe(apiHit.match);
    expect(pwdHit.span[0]).toBe(text.indexOf("password="));
    expect(text.slice(pwdHit.span[0], pwdHit.span[1])).toBe(pwdHit.match);
    // The redacted output replaces both matches in one pass.
    expect(redacted).toBe("hello api_key=[REDACTED:api_key] and password=[REDACTED:password] tail");
  });

  it("emits one hit per match (not one per pattern)", () => {
    const text = "api_key=abcdefghijklmnop1234 api_key=qrstuvwxyz1234567";
    const { hits } = redactWithSpans(text, [
      { name: "api_key_inline", regex: "api_key[\"']?\\s*[:=]\\s*[\"']?([A-Za-z0-9_-]{16,})", replacement: "$1=[REDACTED:api_key]" },
    ]);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.match).toBe("api_key=abcdefghijklmnop1234");
    expect(hits[1]!.match).toBe("api_key=qrstuvwxyz1234567");
    // Spans don't overlap and are in input order.
    expect(hits[1]!.span[0]).toBeGreaterThan(hits[0]!.span[0]);
  });

  it("returns empty hits + unchanged text when no pattern matches", () => {
    const { hits, redacted } = redactWithSpans("nothing to see here", [
      { name: "api_key_inline", regex: "api_key[\"']?\\s*[:=]\\s*[\"']?([A-Za-z0-9_-]{16,})", replacement: "$1=[REDACTED:api_key]" },
    ]);
    expect(hits).toEqual([]);
    expect(redacted).toBe("nothing to see here");
  });

  it("works with the built-in pattern set", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const { hits, redacted } = redactWithSpans(`token=${jwt} seen`, [
      {
        name: "jwt",
        regex: "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+",
        replacement: "[REDACTED:jwt]",
      },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.pattern).toBe("jwt");
    expect(hits[0]!.match).toContain("eyJhbGciOi");
    expect(redacted).toContain("[REDACTED:jwt]");
    expect(redacted).not.toContain("eyJhbGciOi");
  });
});

describe("RedactorLive + RedactionConfig (user patterns)", () => {
  it("applies user patterns from the RedactionConfig layer", async () => {
    const userPatterns = [
      {
        name: "user_phone",
        regex: "\\b\\d{3}-\\d{3}-\\d{4}\\b",
        replacement: "[REDACTED:user_phone]",
      },
    ];
    // Build the RedactorLive-equivalent layer fresh inside the test so
    // Effect's layer memoization doesn't trip the `_op_layer` defect
    // that bites when the module-level `RedactorLive` constant is
    // re-used in a test context. The `Effect.gen` then `yield*`s
    // `Redactor` and `RedactionConfig` against the same layer to
    // exercise the production wiring path.
    const customRedactorLayer = Layer.effect(
      Redactor,
      Effect.gen(function* () {
        const cfg = yield* RedactionConfig;
        return makeRedactor(cfg.userPatterns);
      }),
    );
    const program = Effect.gen(function* () {
      const r = yield* Redactor;
      return r.redact("call 415-555-1234 please");
    });
    const out = await Effect.runPromise(
      Effect.provide(
        program,
        Layer.provide(customRedactorLayer, Layer.succeed(RedactionConfig)({ userPatterns })),
      ) as unknown as Effect.Effect<string, never, never>,
    );
    expect(out).toBe("call [REDACTED:user_phone] please");
  });

  it("still fires the built-in patterns when user patterns are present", async () => {
    const userPatterns = [
      {
        name: "user_phone",
        regex: "\\b\\d{3}-\\d{3}-\\d{4}\\b",
        replacement: "[REDACTED:user_phone]",
      },
    ];
    const customRedactorLayer = Layer.effect(
      Redactor,
      Effect.gen(function* () {
        const cfg = yield* RedactionConfig;
        return makeRedactor(cfg.userPatterns);
      }),
    );
    const program = Effect.gen(function* () {
      const r = yield* Redactor;
      return r.redact("call 415-555-1234 and password=sup3rs3cret");
    });
    const out = await Effect.runPromise(
      Effect.provide(
        program,
        Layer.provide(customRedactorLayer, Layer.succeed(RedactionConfig)({ userPatterns })),
      ) as unknown as Effect.Effect<string, never, never>,
    );
    expect(out).toContain("[REDACTED:user_phone]");
    expect(out).toContain("[REDACTED:password]");
  });

  it("makeRedactor honours user patterns when the config is wired in", () => {
    // The two tests above build a fresh `Layer.effect` inline because
    // the production `RedactorLive` constant triggers an Effect 3.x
    // memoization defect when re-used inside a test `Effect.provide`.
    // The DbLive path (which DOES consume `RedactorLive`) is covered
    // by the event-store / session-service / project-service tests.
    // This is the direct, layer-free check that the makeRedactor
    // constructor merges user patterns on top of the built-ins.
    const r = makeRedactor([
      {
        name: "user_phone",
        regex: "\\b\\d{3}-\\d{3}-\\d{4}\\b",
        replacement: "[REDACTED:user_phone]",
      },
    ]);
    expect(r.redact("call 415-555-1234 and password=sup3rs3cret")).toBe(
      "call [REDACTED:user_phone] and password=[REDACTED:password]",
    );
  });

  it("scanValue returns hits with span + match populated", () => {
    const r = makeRedactor();
    const hits = r.scanValue({ a: "token=abcdefghijklmnop1234" });
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.pattern).toBe("api_key_inline");
    expect(h.fieldPath).toBe("a");
    expect(typeof h.span[0]).toBe("number");
    expect(typeof h.span[1]).toBe("number");
    expect(h.span[1]).toBeGreaterThan(h.span[0]);
    expect(h.match).toBe("token=abcdefghijklmnop1234");
  });
});
