import { describe, expect, it } from "vitest";
import { BUILT_IN_REDACTION_PATTERNS } from "../src/redaction.js";

describe("built-in redaction patterns", () => {
  it("declares the built-in patterns including provider tokens", () => {
    const names = BUILT_IN_REDACTION_PATTERNS.map((p) => p.name);
    expect(names).toEqual([
      "jwt",
      "api_key_inline",
      "pem_block",
      "password_field",
      "openai_sk",
      "github_pat",
    ]);
  });

  it("redacts openai sk- and github pat prefixes without false positives on short tokens", () => {
    const sk = BUILT_IN_REDACTION_PATTERNS.find((p) => p.name === "openai_sk")!;
    const gh = BUILT_IN_REDACTION_PATTERNS.find((p) => p.name === "github_pat")!;
    const skRe = new RegExp(sk.regex, "g");
    const ghRe = new RegExp(gh.regex, "g");
    expect("sk-abcdefghijklmnopqrst".replace(skRe, sk.replacement)).toBe("[REDACTED:openai_sk]");
    expect("sk-short".replace(skRe, sk.replacement)).toBe("sk-short");
    expect("ghp_abcdefghijklmnopqrstuv".replace(ghRe, gh.replacement)).toBe(
      "[REDACTED:github_pat]",
    );
    expect("github_pat_abcdefghijklmnopqrstuv".replace(ghRe, gh.replacement)).toBe(
      "[REDACTED:github_pat]",
    );
  });

  it("all patterns compile to a non-empty regex and replacement", () => {
    for (const p of BUILT_IN_REDACTION_PATTERNS) {
      expect(p.regex.length).toBeGreaterThan(0);
      expect(p.replacement.length).toBeGreaterThan(0);
      // sanity: regex literal parses
      new RegExp(p.regex);
    }
  });
});
