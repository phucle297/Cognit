import { describe, expect, it } from "vitest";
import { makeRedactor, redactEvent } from "../src/redaction";

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
    const result = redactEvent(
      { user: { token: "api_key=abcdefghijklmnop1234" } },
      undefined,
      r,
    );
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
