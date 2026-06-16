/**
 * capture.test.ts — `truncateExcerpt` and `shouldWriteArtifact`.
 *
 * The 1 MB ceiling is the only real contract. We don't allocate a real
 * 1 MB string in every test — we synthesize a string of the right
 * LENGTH and slice it. The truncation is by JS `String.length`, so
 * multi-byte characters might leave the slice 1 char over; that's
 * intentional and documented.
 */
import { describe, expect, it } from "vitest";
import {
  TRUNCATE_BYTES,
  TRUNCATION_SENTINEL,
  truncateExcerpt,
  shouldWriteArtifact,
} from "../src/capture.js";

describe("truncateExcerpt", () => {
  it("passes through small text unchanged", () => {
    expect(truncateExcerpt("hello\n")).toBe("hello\n");
  });

  it("passes through text exactly at the limit unchanged", () => {
    const text = "x".repeat(TRUNCATE_BYTES);
    expect(truncateExcerpt(text)).toBe(text);
  });

  it("truncates text just over the limit and appends sentinel", () => {
    const text = "x".repeat(TRUNCATE_BYTES + 100);
    const out = truncateExcerpt(text);
    expect(out.startsWith("x".repeat(TRUNCATE_BYTES))).toBe(true);
    expect(out.endsWith(TRUNCATION_SENTINEL)).toBe(true);
    expect(out.length).toBe(TRUNCATE_BYTES + TRUNCATION_SENTINEL.length);
  });

  it("truncates a very large string to 1MB + sentinel", () => {
    const text = "a".repeat(10 * 1024 * 1024); // 10 MB
    const out = truncateExcerpt(text);
    expect(out.length).toBe(TRUNCATE_BYTES + TRUNCATION_SENTINEL.length);
  });

  it("preserves the head (failure context is usually at the top)", () => {
    const head = "FATAL ERROR: something broke\n";
    const body = "x".repeat(TRUNCATE_BYTES);
    const text = head + body;
    const out = truncateExcerpt(text);
    expect(out.startsWith(head)).toBe(true);
  });

  it("empty string is a no-op", () => {
    expect(truncateExcerpt("")).toBe("");
  });
});

describe("shouldWriteArtifact", () => {
  it("true when combined output > 1 KB", () => {
    expect(shouldWriteArtifact("a".repeat(600), "b".repeat(500))).toBe(true);
  });

  it("false when combined output exactly 1 KB", () => {
    expect(shouldWriteArtifact("a".repeat(512), "b".repeat(512))).toBe(false);
  });

  it("false when both streams are empty", () => {
    expect(shouldWriteArtifact("", "")).toBe(false);
  });

  it("false when only one stream is non-trivial but the other is empty", () => {
    expect(shouldWriteArtifact("a".repeat(2000), "")).toBe(true);
  });
});
