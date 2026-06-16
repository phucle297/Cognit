/**
 * artifact.test.ts — `sha256` and `writeArtifact`.
 *
 * We use a per-test temp dir under the OS tmpdir so parallel test
 * workers don't collide. Each test cleans up its own dir in a
 * `finally` so failed assertions don't leak.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, writeArtifact } from "../src/artifact.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cognit-artifact-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sha256", () => {
  it("hashes the empty string to the well-known value", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic", () => {
    const a = sha256("hello world");
    const b = sha256("hello world");
    expect(a).toBe(b);
  });

  it("different inputs hash to different outputs", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });

  it("returns 64 lowercase hex chars", () => {
    expect(sha256("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("writeArtifact", () => {
  it("writes <sha256>.log and returns a matching ref", async () => {
    const text = "hello world";
    const ref = await Effect.runPromise(
      writeArtifact({ paths: { artifacts: dir }, text }),
    );
    expect(ref.id).toBe(sha256(text));
    expect(ref.path).toBe(join(dir, `${ref.id}.log`));
    expect(ref.path.endsWith(".log")).toBe(true);
    expect(ref.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
    const onDisk = await readFile(ref.path, "utf8");
    expect(onDisk).toBe(text);
  });

  it("is content-addressed: writing the same text twice yields the same id", async () => {
    const text = "stable content";
    const a = await Effect.runPromise(
      writeArtifact({ paths: { artifacts: dir }, text }),
    );
    const b = await Effect.runPromise(
      writeArtifact({ paths: { artifacts: dir }, text }),
    );
    expect(a.id).toBe(b.id);
    expect(a.path).toBe(b.path);
  });

  it("creates the artifacts dir if it doesn't exist", async () => {
    const nested = join(dir, "deep", "nested", "artifacts");
    const ref = await Effect.runPromise(
      writeArtifact({ paths: { artifacts: nested }, text: "x" }),
    );
    const onDisk = await readFile(ref.path, "utf8");
    expect(onDisk).toBe("x");
  });

  it("never throws on a re-write of the same id", async () => {
    const text = "x";
    await Effect.runPromise(
      writeArtifact({ paths: { artifacts: dir }, text }),
    );
    // second write should be a no-op success.
    const ref = await Effect.runPromise(
      writeArtifact({ paths: { artifacts: dir }, text }),
    );
    expect(ref.id).toBe(sha256(text));
  });

  it("sizeBytes matches Buffer.byteLength for ASCII and unicode", async () => {
    const ascii = "abc";
    const ref1 = await Effect.runPromise(
      writeArtifact({ paths: { artifacts: dir }, text: ascii }),
    );
    expect(ref1.sizeBytes).toBe(3);

    const unicode = "ééé";
    const ref2 = await Effect.runPromise(
      writeArtifact({ paths: { artifacts: dir }, text: unicode }),
    );
    // "é" is 2 bytes in UTF-8 → 6 bytes total
    expect(ref2.sizeBytes).toBe(6);
  });

  it("leaves the directory containing only the .log file (no extra junk)", async () => {
    await Effect.runPromise(
      writeArtifact({ paths: { artifacts: dir }, text: "just one" }),
    );
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/\.log$/);
  });

  it("path is safe — sha256 has no traversal characters", async () => {
    const ref = await Effect.runPromise(
      writeArtifact({ paths: { artifacts: dir }, text: "safe" }),
    );
    // The id is hex only; even if the caller tried, a / would never appear.
    expect(ref.id).not.toMatch(/[^0-9a-f]/);
    expect(ref.path.startsWith(dir)).toBe(true);
  });
});
