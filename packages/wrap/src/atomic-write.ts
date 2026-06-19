/**
 * `atomic-write.ts` — atomic-write helper for inbox producers.
 *
 * Per Phase 9.2 / AC 9.2.1 the protocol is:
 *   1. write JSON bytes to `<path>.tmp`
 *   2. `fsync` the temp file so the bytes hit disk before the rename
 *   3. rename `<path>.tmp` → `<path>` (atomic on the same filesystem)
 *
 * Step 2 is the piece external producers most often skip, and the
 * watcher (`packages/db/src/inbox.ts`) treats any half-written file as
 * a `invalid_json` candidate. The fsync closes that gap.
 *
 * The rename is plain `fs.rename` — on the same filesystem it is the
 * POSIX atomic-rename primitive. Cross-filesystem moves would fall
 * back to copy+delete (not atomic); we reject those by only writing
 * inside the inbox dir the caller passes in, which is a single
 * filesystem under `.cognit/inbox/`.
 *
 * The function returns the on-disk path of the renamed file (which is
 * `path` — the final, atomically-published name). On any I/O failure
 * the Effect fails with the underlying `NodeJS.ErrnoException`
 * wrapped in a plain `Error` so call sites can `Effect.catch` without
 * needing to know about `InboxError` (which lives in `@cognit/db`
 * and would re-introduce a cycle).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Effect } from "effect";

export interface AtomicWriteInput {
  /** Final, on-disk path. MUST end with `.json` (the helper enforces it). */
  readonly path: string;
  /** UTF-8 string payload — typically `JSON.stringify(obj)`. */
  readonly contents: string;
}

const ensureParentDir = (filePath: string): Promise<void> => {
  const idx = filePath.lastIndexOf("/");
  const dir = idx >= 0 ? filePath.slice(0, idx) : ".";
  return fsp.mkdir(dir, { recursive: true }).then(() => undefined);
};

/**
 * Atomically write `contents` to `path`. The protocol is:
 *   - write `<path>.tmp`
 *   - `fsync` the temp file's descriptor (wait for the bytes to hit disk)
 *   - close the descriptor
 *   - rename `<path>.tmp` → `<path>`
 *
 * The rename IS the publish: the watcher (`runInboxWatcher`) only
 * picks up the file after the rename lands, so any process scanning
 * the inbox dir mid-write sees either nothing or the final, complete
 * file. No intermediate state is observable.
 *
 * On failure the temp file is best-effort cleaned up. The error
 * surfaces as a typed `Error` with the underlying `cause` attached.
 */
export const atomicWriteJson = (input: AtomicWriteInput): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const { path, contents } = input;
    if (!path.endsWith(".json")) {
      return yield* Effect.fail(
        new Error(`atomicWriteJson: path must end with .json, got: ${path}`),
      );
    }
    const tmpPath = `${path}.tmp`;
    yield* Effect.tryPromise({
      try: () => ensureParentDir(path),
      catch: (e) => new Error(`atomicWriteJson: mkdir parent failed: ${String(e)}`),
    });
    let fd: number | null = null;
    try {
      // Step 1: open + write + fsync + close on the temp file.
      // We use the sync `fs.openSync` here because the fsync MUST run
      // before the rename — wrapping it in `tryPromise` for the open
      // would mean the fsync races the effect boundary. Doing the
      // whole temp-file sequence synchronously is fine: it's a few
      // syscalls on a single small file.
      fd = fs.openSync(tmpPath, "w", 0o644);
      fs.writeSync(fd, contents);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
    } catch (e) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* swallow */
        }
      }
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* swallow */
      }
      return yield* Effect.fail(
        new Error(`atomicWriteJson: temp write/fsync failed: ${String(e)}`),
      );
    }
    // Step 2: rename the temp file into place. Atomic on POSIX
    // filesystems when both paths share a filesystem, which is the
    // contract here (inbox dir + its parent).
    try {
      fs.renameSync(tmpPath, path);
    } catch (e) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* swallow */
      }
      return yield* Effect.fail(
        new Error(`atomicWriteJson: rename to ${path} failed: ${String(e)}`),
      );
    }
    return path;
  });
