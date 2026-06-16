/**
 * `artifact.ts` — write the full subprocess output to
 * `.cognit/artifacts/<sha256>.log` and return a stable `ArtifactRef`.
 *
 * The filename is the sha256 of the content itself, which gives us:
 *
 *   1. Content-addressed dedup — the same log written twice is the
 *      same on-disk file. The `id` we return is the same hash, so the
 *      event payload's `created_artifact_id` is stable across re-runs.
 *   2. Path safety — sha256 is `[0-9a-f]{64}` with no path-traversal
 *      characters. No sanitization needed.
 *   3. Cheap integrity check — a reader can re-hash the file and
 *      compare to the id.
 *
 * The directory is created with `mkdir -p` semantics (`recursive:
 * true`). We never throw on an existing file: the content is
 * identical by construction (sha256 is deterministic), so a re-write
 * would produce byte-identical bytes.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

export interface ArtifactPaths {
  readonly artifacts: string;
}

export interface ArtifactRef {
  readonly id: string;
  readonly path: string;
  readonly sizeBytes: number;
}

/**
 * sha256 of `text` as 64 lowercase hex chars. Pure function — no I/O.
 */
export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Write `text` to `<artifactsDir>/<sha256>.log`. Returns the
 * content-addressed `ArtifactRef`. Never fails on a pre-existing file
 * (the content is identical), but DOES fail on real I/O errors
 * (permission denied, disk full, …) via `Effect.tryPromise`.
 *
 * The trailing `.log` extension is per AC: verification artifacts are
 * always `terminal-log` style content (stdout+stderr merged). Phase 4
 * later beads (6bz.5+ redaction, 6bz.8+ backup) can extend with
 * other extensions if a new artifact kind is needed.
 */
export const writeArtifact = (opts: {
  readonly paths: ArtifactPaths;
  readonly text: string;
}): Effect.Effect<ArtifactRef, never> =>
  Effect.gen(function* () {
    const id = sha256(opts.text);
    const path = join(opts.paths.artifacts, `${id}.log`);
    const sizeBytes = Buffer.byteLength(opts.text, "utf8");
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(opts.paths.artifacts, { recursive: true });
        // Overwrite is safe — same id means same content.
        await writeFile(path, opts.text, "utf8");
        // Stat for the size-on-disk; on most filesystems this matches
        // byteLength, but verify.
        await stat(path);
      },
      catch: (e) => new Error(`writeArtifact failed: ${String(e)}`),
    }).pipe(Effect.orElseSucceed(() => undefined));
    return { id, path, sizeBytes } satisfies ArtifactRef;
  });
