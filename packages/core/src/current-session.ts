/**
 * Sticky current-session pointer — shared by the CLI (`auto-session`,
 * `session-resolver`) and the DB inbox ingest path (`SessionService.ingest`).
 *
 * `.cognit/current-session` is a plain text file holding the active
 * session ULID. Producers (hooks, `@cognit/wrap`) read it to stamp a
 * real session id onto envelopes; `SessionService.ingest` reads/writes
 * it so a stream of placeholder-session envelopes (written before any
 * session exists) all collapse onto one bootstrap session.
 *
 * The pointer is a *convenience*, never a contract — `--session` is
 * always authoritative, and a stale pointer (mtime > 24h ago) prints a
 * warning when resolved.
 *
 * Write strategy: atomic rename. Concurrent `session create` from two
 * terminals is benign: both writes succeed at the FS level, last-
 * writer-wins on read. No file lock, no CRDT, no OT — those are
 * overkill for a single ULID string.
 */

import fs from "node:fs";
import { projectPaths } from "./paths.js";

/** A pointer older than 24h prints a warning (but does not error). */
const STALE_MS = 24 * 60 * 60 * 1000;

export interface ResolvedPointer {
  readonly sessionId: string;
  readonly stale: boolean;
  readonly mtime: number;
}

/**
 * Read the sticky pointer from disk. Returns `null` when the file is
 * absent or unparseable. Stale pointers return `stale: true` so the
 * caller can warn but the user might genuinely be resuming old work.
 *
 * `onInvalid` is invoked (best-effort, non-fatal) when the pointer file
 * exists but does not hold a valid ULID, so the CLI can surface a
 * stderr warning. The DB ingest path passes a no-op — it resolves
 * silently and mints a fresh session instead.
 */
export function readCurrentSession(
  projectRoot: string,
  options?: { readonly now?: number; readonly onInvalid?: (raw: string) => void },
): ResolvedPointer | null {
  const now = options?.now ?? Date.now();
  const onInvalid = options?.onInvalid ?? (() => {});
  const paths = projectPaths(projectRoot);
  if (!fs.existsSync(paths.currentSession)) {
    return null;
  }
  const raw = fs.readFileSync(paths.currentSession, "utf8").trim();
  if (raw.length === 0) {
    return null;
  }
  // ULID shape: 26 chars of Crockford base32. Anything else is a
  // pointer that no session row can ever resolve to — treat as null.
  const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  if (!ULID.test(raw)) {
    onInvalid(raw);
    return null;
  }
  const stat = fs.statSync(paths.currentSession);
  return {
    sessionId: raw,
    stale: now - stat.mtimeMs > STALE_MS,
    mtime: stat.mtimeMs,
  };
}

/**
 * Atomically write the sticky pointer. Writes to a tmp file, fsyncs,
 * renames over the target. Idempotent on the new value.
 */
export function writeCurrentSession(projectRoot: string, sessionId: string): void {
  const paths = projectPaths(projectRoot);
  fs.mkdirSync(paths.dir, { recursive: true });
  const handle = fs.openSync(paths.currentSessionTmp, "w");
  try {
    fs.writeSync(handle, `${sessionId}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(paths.currentSessionTmp, paths.currentSession);
}

/**
 * Clear the sticky pointer. Idempotent: removing a non-existent file
 * is a no-op.
 */
export function clearCurrentSession(projectRoot: string): void {
  const paths = projectPaths(projectRoot);
  try {
    fs.unlinkSync(paths.currentSession);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
