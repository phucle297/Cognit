/**
 * `packages/wrap/test/index.test.ts` — unit tests for the wrap
 * producer (Phase 9.2).
 *
 * Coverage map:
 *   - AC 9.2.1 (happy path)        — `node -e "process.exit(0)"`
 *                                    spawns, emits one terminal
 *                                    inbox file with
 *                                    `verification_passed`,
 *                                    exit_code=0. Atomic-write
 *                                    helper exercised transitively.
 *   - AC 9.2.2 (per-stderr-line)  — `bash -c 'echo oops >&2'`
 *                                    produces at least one
 *                                    `observation_recorded` envelope.
 *   - AC 9.2.3 (failure paths)    — exit 1 emits
 *                                    `verification_failed`; spawn
 *                                    of a nonexistent binary emits
 *                                    `verification_errored` with
 *                                    `error_code=enoent`.
 *   - AC 9.2.4 (artifact)         — combined stdout+stderr > 1024
 *                                    chars creates
 *                                    `artifacts/<sha>.log` and
 *                                    `artifactRefs` on the
 *                                    terminal envelope.
 *
 * Each AC has at least one positive and one negative case as
 * required by the project's quality gate.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { mkdtemp, mkdir, rm, readFile, readdir, stat } from "node:fs/promises";
import { writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// (No file-level fs mock needed: the mode-0o600 test inspects the
// final published file — `renameSync` preserves the source inode's
// mode bits, so the file at the target path keeps the 0o600 set by
// `openSync(tmpPath, "wx", 0o600)`. See test body for rationale.)
import {
  runWrap,
  appendInboxEnvelope,
  inboxFilename,
  WRAP_SCHEMA_VERSION,
  type WrapEnvelope,
} from "../src/index.js";
import { atomicWriteJson } from "../src/atomic-write.js";
import { ulid } from "ulid";

let inboxDir = "";
let artifactsDir = "";
let sessionId = "";

const sessionUlid = "0123456789ABCDEFGHJKMNPQRS";

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "cognit-wrap-"));
  inboxDir = join(root, "inbox");
  artifactsDir = join(root, "artifacts");
  await rm(inboxDir, { recursive: true, force: true });
  await rm(artifactsDir, { recursive: true, force: true });
  await new Promise((r) => setImmediate(r));
  // sessionId is a valid ULID; the watcher will accept it as a
  // filename prefix without needing an actual DB row (the watcher
  // calls appendEvent with it, and appendEvent auto-creates the
  // session if missing). These tests don't touch the DB so we
  // just use a fresh ULID per test for envelope uniqueness.
  sessionId = ulid();
});

afterEach(async () => {
  await rm(inboxDir, { recursive: true, force: true });
  await rm(artifactsDir, { recursive: true, force: true });
});

const baseInput = (command: readonly string[]) => ({
  command,
  cwd: process.cwd(),
  env: process.env,
  inboxDir,
  artifactsDir,
  sessionId,
});

const parseEnvelopeFile = async (filePath: string): Promise<WrapEnvelope> => {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text) as WrapEnvelope;
};

describe("atomicWriteJson — AC 9.2.1 atomic-write helper", () => {
  it("writes the file at the requested path with no leftover .tmp", async () => {
    const filePath = join(inboxDir, "test.json");
    const written = await Effect.runPromise(
      atomicWriteJson({ path: filePath, contents: "{\"hello\":\"world\"}" }),
    );
    expect(written).toBe(filePath);
    const onDisk = await readFile(filePath, "utf8");
    expect(onDisk).toBe("{\"hello\":\"world\"}");
    const entries = await readdir(inboxDir);
    expect(entries).toContain("test.json");
    expect(entries).not.toContain("test.json.tmp");
  });

  it("rejects paths not ending in .json", async () => {
    const filePath = join(inboxDir, "test.txt");
    const result = await Effect.runPromise(
      Effect.either(atomicWriteJson({ path: filePath, contents: "x" })),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const message = (result.left as Error).message;
      expect(message).toMatch(/\.json/);
    }
  });

  it("fsync + rename yields the final path with no partial .tmp", async () => {
    // A concurrent reader of the inbox dir should never observe a
    // `.tmp` file at any point. We exercise the protocol by writing
    // many small files in parallel — the rename is atomic on POSIX
    // so a reader sees either nothing or the final file.
    const writes = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 50 }, (_, i) =>
          atomicWriteJson({ path: join(inboxDir, `f${i}.json`), contents: String(i) }),
        ),
        { concurrency: 8, discard: false },
      ) as unknown as Effect.Effect<ReadonlyArray<string>, never, never>,
    );
    expect(writes).toHaveLength(50);
    const entries = await readdir(inboxDir);
    expect(entries.sort()).toEqual(Array.from({ length: 50 }, (_, i) => `f${i}.json`).sort());
  });

  it("refuses to open an existing .tmp (O_EXCL/EEXIST) — does not silently truncate", async () => {
    // Simulate a prior crash leaving a stale `.tmp` on disk, or an
    // attacker who has planted a symlink at the temp path. The
    // `"wx"` flag is `O_CREAT | O_EXCL | O_WRONLY` — opening MUST
    // fail with EEXIST rather than silently truncating and
    // overwriting the existing file.
    //
    // (Note: on failure, the helper best-effort `unlinkSync`s the
    // temp path — that's the documented cleanup contract. So we do
    // NOT assert the stale `.tmp` survives; we assert (a) the call
    // fails with a wrapper that mentions EEXIST, (b) the final
    // target path was NOT created (no rename ran), and (c) the
    // helper cleaned up the stale `.tmp` so a retry is safe.)
    await mkdir(inboxDir, { recursive: true, mode: 0o700 });
    const filePath = join(inboxDir, "stale.json");
    const tmpPath = `${filePath}.tmp`;
    const staleMarker = "stale-content-from-prior-crash";
    writeFileSync(tmpPath, staleMarker);

    const result = await Effect.runPromise(
      Effect.either(atomicWriteJson({ path: filePath, contents: "{\"fresh\":true}" })),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      // The error message must surface EEXIST (or the documented
      // "temp write/fsync failed" wrapper). The wrapper must not
      // swallow the underlying errno.
      const message = (result.left as Error).message;
      expect(message).toMatch(/EEXIST|temp write\/fsync failed/);
    }

    // The final path must not exist (the rename never ran).
    const entries = await readdir(inboxDir);
    expect(entries).not.toContain("stale.json");

    // The helper cleans up the stale `.tmp` on failure — a retry
    // after the cleanup must succeed and produce the fresh payload.
    const retry = await Effect.runPromise(
      atomicWriteJson({ path: filePath, contents: "{\"fresh\":true}" }),
    );
    expect(retry).toBe(filePath);
    expect(await readFile(filePath, "utf8")).toBe("{\"fresh\":true}");
  });

  it("refuses to open when .tmp is a symlink (EEXIST, no follow)", async () => {
    // Same race as above but exercised via a symlink planted at the
    // temp path. With `"wx"`, openSync must fail before any write
    // reaches the symlink target. (Node does not expose O_NOFOLLOW
    // directly; `wx` + parent-dir mode 0o700 close this gap, and
    // this test pins the wx behaviour.)
    await mkdir(inboxDir, { recursive: true, mode: 0o700 });
    const filePath = join(inboxDir, "symlinked.json");
    const tmpPath = `${filePath}.tmp`;
    const outsidePath = join(inboxDir, "victim.json");
    // Plant a dangling symlink: the target does not exist, but openSync
    // would still happily traverse it without `wx`/`O_EXCL`. With
    // `wx`, the open itself must fail because the symlink *entry*
    // already exists, regardless of the target.
    symlinkSync(outsidePath, tmpPath);

    const result = await Effect.runPromise(
      Effect.either(atomicWriteJson({ path: filePath, contents: "{\"x\":1}" })),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const message = (result.left as Error).message;
      expect(message).toMatch(/EEXIST|temp write\/fsync failed/);
    }

    // The symlink target must NOT have been created (openSync refused
    // before any write). We never created `outsidePath` again, so
    // readdir confirms it.
    const entries = await readdir(inboxDir);
    expect(entries).not.toContain("victim.json");
    await rm(tmpPath, { force: true });
  });

  it("creates the temp file with mode 0o600 (owner read/write only)", async () => {
    // The temp file is created with `fs.openSync(tmpPath, "wx", 0o600)`.
    // `fs.renameSync` preserves the source inode's mode bits, so the
    // file at the target path keeps the 0o600 set at openSync time.
    // (The umask can only STRIP bits from the requested mode; it
    // cannot add them. 0o600 & ~umask = 0o600 for any umask whose
    // other-write bit (0o002) is set — which is the default on every
    // platform we run on.)
    await mkdir(inboxDir, { recursive: true, mode: 0o700 });
    const filePath = join(inboxDir, "mode-temp.json");

    const written = await Effect.runPromise(
      atomicWriteJson({ path: filePath, contents: "{\"a\":1}" }),
    );
    expect(written).toBe(filePath);

    const s = await stat(filePath);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("creates a missing parent directory with mode 0o700 (owner only)", async () => {
    // `ensureParentDir` runs `fsp.mkdir(dir, { recursive: true, mode: 0o700 })`.
    // Mode applies only to newly created dirs, so we delete the
    // parent (the inbox subdir was already created by the fixture)
    // and let atomicWriteJson re-create it. We use a nested subpath
    // under a brand-new parent so the parent does not pre-exist.
    const nestedParent = join(inboxDir, "nested", "deep");
    const filePath = join(nestedParent, "child.json");

    // Sanity: the nested parent must not exist yet.
    expect((await stat(nestedParent).catch(() => null))).toBeNull();

    const written = await Effect.runPromise(
      atomicWriteJson({ path: filePath, contents: "{\"ok\":1}" }),
    );
    expect(written).toBe(filePath);

    const parentStat = await stat(nestedParent);
    expect(parentStat.isDirectory()).toBe(true);
    expect(parentStat.mode & 0o777).toBe(0o700);

    // And the file itself must be readable (write path still works).
    expect(await readFile(filePath, "utf8")).toBe("{\"ok\":1}");
  });
});

describe("inboxFilename — AC 9.2.1 filename contract", () => {
  it("matches <session>-<ulid>.json", () => {
    const name = inboxFilename(sessionUlid, "0123456789ABCDEFGHJKMNPQRT");
    expect(name).toBe(`${sessionUlid}-0123456789ABCDEFGHJKMNPQRT.json`);
  });
});

describe("appendInboxEnvelope — AC 9.2.1 envelope shape", () => {
  it("stamps schema_version=1.1.0 and a per-event ULID", async () => {
    const env: WrapEnvelope = {
      type: "observation_recorded",
      version: WRAP_SCHEMA_VERSION,
      session_id: sessionUlid,
      actor_name: "test",
      actor_type: "worker",
      id: "0123456789ABCDEFGHJKMNPQRT",
      payload: { text: "hello" },
    };
    const filePath = await Effect.runPromise(appendInboxEnvelope(inboxDir, env));
    expect(filePath).toBe(join(inboxDir, `${sessionUlid}-${env.id}.json`));
    const onDisk = await parseEnvelopeFile(filePath);
    expect(onDisk.version).toBe("1.1.0");
    expect(onDisk.session_id).toBe(sessionUlid);
    expect(onDisk.actor_type).toBe("worker");
    expect(onDisk.payload).toEqual({ text: "hello" });
  });
});

describe("runWrap — AC 9.2.1 spawn + capture + atomic-write", () => {
  it("happy path: spawns `node -e process.exit(0)` and writes one verification_passed envelope", async () => {
    const out = await Effect.runPromise(
      runWrap(baseInput(["node", "-e", "process.exit(0)"])),
    );
    expect(out.terminalType).toBe("verification_passed");
    expect(out.writtenFiles).toHaveLength(1);
    expect(out.spawnErrorCode).toBeUndefined();
    expect(out.artifact).toBeNull();

    const env = await parseEnvelopeFile(out.writtenFiles[0]!);
    expect(env.type).toBe("verification_passed");
    expect(env.session_id).toBe(sessionId);
    expect(env.actor_type).toBe("worker");
    expect(env.actor_name).toBe("cognit-wrap");
    expect(env.version).toBe("1.1.0");
    const payload = env.payload as { exit_code?: number; duration_ms?: number };
    expect(payload.exit_code).toBe(0);
    expect(typeof payload.duration_ms).toBe("number");
  });

  it("no stderr lines means no observation envelopes (per-line policy)", async () => {
    const out = await Effect.runPromise(
      runWrap(baseInput(["node", "-e", "process.exit(0)"])),
    );
    expect(out.writtenFiles).toHaveLength(1);
    // Only the terminal envelope is on disk.
    const entries = await readdir(inboxDir);
    expect(entries).toHaveLength(1);
  });
});

describe("runWrap — AC 9.2.2 per-stderr-line observation policy", () => {
  it("emits one observation_recorded envelope per non-empty stderr line", async () => {
    const out = await Effect.runPromise(
      runWrap(
        baseInput([
          "bash",
          "-c",
          "echo line1 1>&2; echo line2 1>&2; echo line3 1>&2; exit 1",
        ]),
      ),
    );
    expect(out.terminalType).toBe("verification_failed");
    // Three stderr lines + one terminal.
    expect(out.writtenFiles.length).toBeGreaterThanOrEqual(4);
    const types: string[] = [];
    for (const f of out.writtenFiles) {
      const env = await parseEnvelopeFile(f);
      types.push(env.type);
    }
    const observationCount = types.filter((t) => t === "observation_recorded").length;
    expect(observationCount).toBe(3);
  });

  it("each observation envelope carries payload.text = the line content", async () => {
    const out = await Effect.runPromise(
      runWrap(baseInput(["bash", "-c", "echo alpha 1>&2; echo beta 1>&2; exit 1"])),
    );
    const lines: string[] = [];
    for (const f of out.writtenFiles) {
      const env = await parseEnvelopeFile(f);
      if (env.type === "observation_recorded") {
        const text = (env.payload as { text?: unknown }).text;
        if (typeof text === "string") lines.push(text);
      }
    }
    expect(lines.sort()).toEqual(["alpha", "beta"]);
  });

  it("observation envelopes are emitted even when the child exits 0", async () => {
    const out = await Effect.runPromise(
      runWrap(baseInput(["bash", "-c", "echo warning 1>&2"])),
    );
    expect(out.terminalType).toBe("verification_passed");
    const types: string[] = [];
    for (const f of out.writtenFiles) {
      const env = await parseEnvelopeFile(f);
      types.push(env.type);
    }
    // One stderr line + one terminal.
    expect(types.filter((t) => t === "observation_recorded").length).toBe(1);
    expect(types.filter((t) => t === "verification_passed").length).toBe(1);
  });
});

describe("runWrap — AC 9.2.3 terminal-event mapping", () => {
  it("exit non-zero -> verification_failed", async () => {
    const out = await Effect.runPromise(
      runWrap(baseInput(["node", "-e", "process.exit(7)"])),
    );
    expect(out.terminalType).toBe("verification_failed");
    expect(out.spawnErrorCode).toBeUndefined();
    const terminal = out.writtenFiles[out.writtenFiles.length - 1]!;
    const env = await parseEnvelopeFile(terminal);
    expect(env.type).toBe("verification_failed");
    const payload = env.payload as { exit_code?: number };
    expect(payload.exit_code).toBe(7);
  });

  it("ENOENT on spawn -> verification_errored with spawnErrorCode=enoent", async () => {
    const out = await Effect.runPromise(
      runWrap(baseInput(["/no/such/binary/xyz-abc-12345"])),
    );
    expect(out.terminalType).toBe("verification_errored");
    expect(out.spawnErrorCode).toBe("enoent");
    const terminal = out.writtenFiles[0]!;
    const env = await parseEnvelopeFile(terminal);
    expect(env.type).toBe("verification_errored");
    const payload = env.payload as { error_code?: string; error?: string };
    expect(payload.error_code).toBe("enoent");
    expect(typeof payload.error).toBe("string");
    expect(payload.error!.length).toBeGreaterThan(0);
  });

  it("errored path does NOT create an artifact (no output captured)", async () => {
    const out = await Effect.runPromise(
      runWrap(baseInput(["/no/such/binary/xyz-abc-9999"])),
    );
    expect(out.artifact).toBeNull();
    const entries = await readdir(artifactsDir).catch(() => [] as string[]);
    expect(entries).toHaveLength(0);
  });
});

describe("runWrap — AC 9.2.4 artifact on large output", () => {
  it("writes artifacts/<sha>.log when combined output > 1024 chars", async () => {
    const out = await Effect.runPromise(
      runWrap(
        baseInput([
          "node",
          "-e",
          "process.stdout.write('x'.repeat(2000))",
        ]),
      ),
    );
    expect(out.terminalType).toBe("verification_passed");
    expect(out.artifact).not.toBeNull();
    const ref = out.artifact!;
    expect(ref.path.startsWith(artifactsDir)).toBe(true);
    expect(ref.path.endsWith(".log")).toBe(true);

    const onDisk = await readFile(ref.path, "utf8");
    const sha = createHash("sha256").update(onDisk, "utf8").digest("hex");
    expect(sha).toBe(ref.id);

    const s = await stat(ref.path);
    expect(s.size).toBe(ref.sizeBytes);

    // The terminal envelope references the artifact.
    const terminal = out.writtenFiles[out.writtenFiles.length - 1]!;
    const env = await parseEnvelopeFile(terminal);
    expect(env.artifactRefs).toEqual([ref.id]);
  });

  it("does NOT write an artifact when combined output is small (< 1024 chars)", async () => {
    const out = await Effect.runPromise(
      runWrap(baseInput(["node", "-e", "process.stdout.write('short')"])),
    );
    expect(out.artifact).toBeNull();
    const terminal = out.writtenFiles[out.writtenFiles.length - 1]!;
    const env = await parseEnvelopeFile(terminal);
    expect(env.artifactRefs).toBeUndefined();
  });
});

describe("runWrap — sink path integrity", () => {
  it("every written file matches <session-id>-<ulid>.json", async () => {
    const out = await Effect.runPromise(
      runWrap(baseInput(["node", "-e", "process.exit(0)"])),
    );
    for (const f of out.writtenFiles) {
      const base = f.split("/").pop()!;
      expect(base).toMatch(new RegExp(`^${sessionId}-[0-9A-HJKMNP-TV-Z]{26}\\.json$`));
    }
  });

  it("no .tmp files remain on disk after the run", async () => {
    await Effect.runPromise(
      runWrap(baseInput(["node", "-e", "process.exit(0)"])),
    );
    const entries = await readdir(inboxDir);
    expect(entries.some((n) => n.endsWith(".tmp"))).toBe(false);
  });
});

describe("runWrap — single-spawn guarantee (P0 fix)", () => {
  it("runs the wrapped command exactly ONCE (no re-spawn for stderr capture)", async () => {
    // Side-effect counter survives the run. Each invocation of the
    // wrapped command increments it. If wrap re-spawned to capture
    // stderr (the pre-fix bug), the count would be 2.
    const counterFile = join(inboxDir, "counter.txt");
    const counterScript = `
      const fs = require('fs');
      const f = ${JSON.stringify(counterFile)};
      const n = (parseInt(fs.existsSync(f) ? fs.readFileSync(f,'utf8') : '0', 10) + 1);
      fs.writeFileSync(f, String(n));
      process.stderr.write('hit-' + n + String.fromCharCode(10));
      process.exit(0);
    `;
    const out = await Effect.runPromise(
      runWrap(baseInput(["node", "-e", counterScript])),
    );
    expect(out.terminalType).toBe("verification_passed");
    const count = parseInt(await readFile(counterFile, "utf8"), 10);
    expect(count).toBe(1);

    // And the stderr observation should reference hit-1 (the only run).
    const observations: WrapEnvelope[] = [];
    for (const f of out.writtenFiles) {
      const env = await parseEnvelopeFile(f);
      if (env.type === "observation_recorded") observations.push(env);
    }
    expect(observations).toHaveLength(1);
    expect((observations[0]!.payload as { text: string }).text).toBe("hit-1");
  });

  it("does NOT re-spawn on the errored (ENOENT) path either", async () => {
    const out = await Effect.runPromise(
      runWrap(baseInput(["/no/such/binary/never-exists-xyz-qqq"])),
    );
    expect(out.terminalType).toBe("verification_errored");
    expect(out.writtenFiles).toHaveLength(1);
    const only = out.writtenFiles[0]!;
    const env = await parseEnvelopeFile(only);
    expect(env.type).toBe("verification_errored");
  });
});
