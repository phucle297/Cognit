/**
 * runVerification.test.ts — the integration tests for the composer.
 *
 * What we verify end-to-end:
 *   - exit 0 -> verification_passed, no stderr_excerpt, artifact only
 *     when output > 1 KB
 *   - exit non-zero -> verification_failed, stderr_excerpt present
 *   - ENOENT -> verification_errored with error_code=enoent
 *   - the `onTerminal` callback is invoked exactly once per run
 *   - the artifact file on disk matches what `created_artifact_id`
 *     points at (sha256 of the on-disk file equals the event id)
 *   - small output (< 1 KB) does NOT create an artifact
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Effect, Ref } from "effect";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  runVerification,
  type TerminalEvent,
  type RunVerificationInput,
} from "../src/index.js";

let artifactsDir = "";
let captured: TerminalEvent[] = [];

const onTerminal = (event: TerminalEvent) =>
  Effect.sync(() => {
    captured.push(event);
  });

const baseInput = (command: readonly string[]): RunVerificationInput => ({
  command,
  cwd: process.cwd(),
  env: process.env,
  signal: new AbortController().signal,
  paths: { artifacts: artifactsDir },
  onTerminal,
});

beforeEach(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), "cognit-run-"));
  captured = [];
});

afterEach(async () => {
  await rm(artifactsDir, { recursive: true, force: true });
});

describe("runVerification — happy path (exit 0)", () => {
  it("emits verification_passed with exit_code, duration, stdout_excerpt", async () => {
    const out = await Effect.runPromise(
      runVerification(
        baseInput(["node", "-e", "process.stdout.write('ok')"]),
      ),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.type).toBe("verification_passed");
    expect(out.terminal.type).toBe("verification_passed");
    expect(out.error).toBeNull();

    const payload = captured[0]?.payload as Record<string, unknown>;
    expect(payload.exit_code).toBe(0);
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
    expect(payload.stdout_excerpt).toBe("ok");
    expect(payload.stderr_excerpt).toBeUndefined();
  });

  it("does NOT create an artifact when output is small (< 1 KB)", async () => {
    const out = await Effect.runPromise(
      runVerification(
        baseInput(["node", "-e", "process.stdout.write('short')"]),
      ),
    );
    expect(out.artifact).toBeNull();
    const payload = captured[0]?.payload as Record<string, unknown>;
    expect(payload.created_artifact_id).toBeUndefined();
  });

  it("creates an artifact when output exceeds 1 KB", async () => {
    // ~2 KB of output
    const out = await Effect.runPromise(
      runVerification(
        baseInput([
          "node",
          "-e",
          "process.stdout.write('x'.repeat(2000))",
        ]),
      ),
    );
    expect(out.artifact).not.toBeNull();
    const ref = out.artifact!;
    expect(ref.path.startsWith(artifactsDir)).toBe(true);
    expect(ref.path.endsWith(".log")).toBe(true);

    const onDisk = await readFile(ref.path, "utf8");
    const sha = createHash("sha256").update(onDisk, "utf8").digest("hex");
    expect(sha).toBe(ref.id);

    const payload = captured[0]?.payload as Record<string, unknown>;
    expect(payload.created_artifact_id).toBe(ref.id);
  });
});

describe("runVerification — failure path (exit != 0)", () => {
  it("emits verification_failed with stderr_excerpt, no error_code", async () => {
    const out = await Effect.runPromise(
      runVerification(
        baseInput([
          "node",
          "-e",
          "process.stderr.write('boom'); process.exit(2)",
        ]),
      ),
    );
    expect(out.terminal.type).toBe("verification_failed");
    expect(out.error).toBeNull();

    const payload = captured[0]?.payload as Record<string, unknown>;
    expect(payload.exit_code).toBe(2);
    expect(payload.stderr_excerpt).toBe("boom");
    expect(payload.error_code).toBeUndefined();
  });

  it("emits verification_failed with artifact when output is large", async () => {
    await Effect.runPromise(
      runVerification(
        baseInput([
          "node",
          "-e",
          "process.stderr.write('y'.repeat(2000)); process.exit(1)",
        ]),
      ),
    );
    const payload = captured[0]?.payload as Record<string, unknown>;
    expect(payload.created_artifact_id).toBeDefined();
    expect(typeof payload.created_artifact_id).toBe("string");
  });
});

describe("runVerification — error path (SpawnError)", () => {
  it("ENOENT -> verification_errored with error_code=enoent", async () => {
    const out = await Effect.runPromise(
      runVerification(
        baseInput(["/no/such/binary/exists/anywhere-xyz"]),
      ),
    );
    expect(out.terminal.type).toBe("verification_errored");
    expect(out.error).not.toBeNull();
    expect(out.error?.code).toBe("enoent");

    const payload = captured[0]?.payload as Record<string, unknown>;
    expect(payload.error_code).toBe("enoent");
    expect(typeof payload.error).toBe("string");
    expect((payload.error as string).length).toBeGreaterThan(0);
  });

  it("errored path does NOT create an artifact (no output captured)", async () => {
    const out = await Effect.runPromise(
      runVerification(
        baseInput(["/no/such/binary/exists/anywhere-xyz-2"]),
      ),
    );
    expect(out.artifact).toBeNull();
  });
});

describe("runVerification — callback semantics", () => {
  it("invokes onTerminal exactly once per run", async () => {
    const ref = await Effect.runPromise(Ref.make(0));
    const counter = (event: TerminalEvent) =>
      Effect.gen(function* () {
        yield* Ref.update(ref, (n) => n + 1);
        return event;
      });

    await Effect.runPromise(
      runVerification({
        ...baseInput(["node", "-e", "process.exit(0)"]),
        onTerminal: counter,
      }),
    );
    const n = await Effect.runPromise(Ref.get(ref));
    expect(n).toBe(1);
  });

  it("invokes onTerminal for both spawn error and exit-non-zero cases", async () => {
    // already exercised above; this is a simple guard against the
    // bug where a SpawnError would short-circuit the callback.
    await Effect.runPromise(
      runVerification(baseInput(["/nope/nope/nope"])),
    );
    await Effect.runPromise(
      runVerification(baseInput(["node", "-e", "process.exit(1)"])),
    );
    expect(captured).toHaveLength(2);
    expect(captured[0]?.type).toBe("verification_errored");
    expect(captured[1]?.type).toBe("verification_failed");
  });
});

describe("runVerification — exit code mapping", () => {
  it.each([0, 1, 2, 127, 255])("exit %i maps correctly", async (code) => {
    await Effect.runPromise(
      runVerification(baseInput(["node", "-e", `process.exit(${code})`])),
    );
    const payload = captured[0]?.payload as Record<string, unknown>;
    expect(payload.exit_code).toBe(code);
    if (code === 0) {
      expect(captured[0]?.type).toBe("verification_passed");
    } else {
      expect(captured[0]?.type).toBe("verification_failed");
    }
  });
});

describe("runVerification — artifact integration", () => {
  it("artifact file size matches sizeBytes in ref", async () => {
    const out = await Effect.runPromise(
      runVerification(
        baseInput([
          "node",
          "-e",
          "process.stdout.write('z'.repeat(3000))",
        ]),
      ),
    );
    expect(out.artifact).not.toBeNull();
    const s = await stat(out.artifact!.path);
    expect(s.size).toBe(out.artifact!.sizeBytes);
  });
});
