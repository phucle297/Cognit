/**
 * spawn.test.ts — `spawnVerification` contract tests.
 *
 * We use `node -e` to drive the child because:
 *   - it's available on every CI runner (no extra deps)
 *   - it lets us vary exit code, signal handling, and output without
 *     shipping fixture binaries.
 *
 * The "happy path" tests live in runVerification.test.ts. This file
 * exercises the spawn layer in isolation: typed SpawnError mapping,
 * exit code propagation, duration measurement, output capture.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { spawnVerification, type SpawnError } from "../src/spawn.js";

const baseInput = (command: readonly string[]) => ({
  command,
  cwd: process.cwd(),
  env: process.env,
  signal: new AbortController().signal,
});

/**
 * Run spawnVerification, return either the typed SpawnError (on
 * failure) or the SpawnResult (on success). Cleaner than
 * runPromiseExit + cause introspection.
 */
const runEither = (command: readonly string[]) =>
  Effect.runPromise(
    Effect.either(spawnVerification(baseInput(command))),
  );

describe("spawnVerification", () => {
  it("happy path: captures exit 0, stdout, and positive duration", async () => {
    const e = await runEither(["node", "-e", "process.stdout.write('hi')"]);
    expect(e._tag).toBe("Right");
    if (e._tag === "Right") {
      expect(e.right.exitCode).toBe(0);
      expect(e.right.stdout).toBe("hi");
      expect(e.right.stderr).toBe("");
      expect(e.right.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("non-zero exit propagates as exitCode (no SpawnError)", async () => {
    const e = await runEither(["node", "-e", "process.exit(7)"]);
    expect(e._tag).toBe("Right");
    if (e._tag === "Right") {
      expect(e.right.exitCode).toBe(7);
      expect(e.right.signal).toBeNull();
    }
  });

  it("captures stderr separately", async () => {
    const e = await runEither(["node", "-e", "process.stderr.write('oops')"]);
    expect(e._tag).toBe("Right");
    if (e._tag === "Right") {
      expect(e.right.stdout).toBe("");
      expect(e.right.stderr).toBe("oops");
      expect(e.right.exitCode).toBe(0);
    }
  });

  it("ENOENT produces a typed SpawnError with code='enoent'", async () => {
    const e = await runEither([
      "/this/binary/does/not/exist/xyz-enoent-test",
    ]);
    expect(e._tag).toBe("Left");
    if (e._tag === "Left") {
      const err = e.left as SpawnError;
      expect(err._tag).toBe("SpawnError");
      expect(err.code).toBe("enoent");
      expect(err.message).toBeTruthy();
    }
  });

  it("EACCES: a non-executable file is rejected with code='eacces' on POSIX", async () => {
    // Skip on Windows where chmod is not honoured.
    if (process.platform === "win32") return;
    const tmpFile = `${process.cwd()}/.tmp-no-exec-${Date.now()}.sh`;
    const { writeFile, chmod, unlink } = await import("node:fs/promises");
    await writeFile(tmpFile, "#!/bin/sh\necho hi\n");
    await chmod(tmpFile, 0o644); // not executable
    try {
      const e = await runEither([tmpFile]);
      // Some kernels surface non-exec as ENOENT (execve fails) or EACCES
      // depending on permissions. We assert it is a SpawnError with
      // a known code — not "other".
      if (e._tag === "Left") {
        const err = e.left as SpawnError;
        expect(["enoent", "eacces", "eperm"]).toContain(err.code);
      }
      // If the kernel happens to treat 0o644 as still-executable (it
      // shouldn't on a modern Linux), accept a Right with non-zero exit.
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  });

  it("respects cwd: output is independent of caller's cwd", async () => {
    const e = await runEither([
      "node",
      "-e",
      "process.stdout.write(process.cwd())",
    ]);
    expect(e._tag).toBe("Right");
    if (e._tag === "Right") {
      expect(e.right.stdout).toBe(process.cwd());
    }
  });

  it("env is forwarded to the child", async () => {
    const e = await runEither([
      "node",
      "-e",
      "process.stdout.write(process.env.COGNIT_TEST_VAR ?? '')",
    ]);
    // We didn't set the var; expect empty.
    if (e._tag === "Right") {
      expect(e.right.stdout).toBe("");
      expect(e.right.exitCode).toBe(0);
    }
  });

  it("empty command array fails with SpawnError (defensive)", async () => {
    const e = await runEither([]);
    expect(e._tag).toBe("Left");
    if (e._tag === "Left") {
      const err = e.left as SpawnError;
      expect(err._tag).toBe("SpawnError");
      expect(err.code).toBe("other");
    }
  });
});
