/**
 * Session-id resolution helper.
 *
 * Every command that needs a session id accepts `--session <id>`. When
 * the flag is omitted, we fall back to the sticky current-session
 * pointer at `.cognit/current-session`. An explicit `--session` always
 * wins; a stale pointer (>24h) prints a warning but does NOT error
 * (the user might genuinely be resuming old work).
 */

import { readCurrentSession } from "./current-session.js";

/**
 * Resolve the session id to use. Order of precedence:
 * 1. `explicit` (from `--session` flag), if defined
 * 2. Sticky pointer at `.cognit/current-session`
 *
 * Returns the id and `null` when neither is available. The caller is
 * expected to error with a clear message. The `stale` flag is set
 * when the pointer was read but is older than 24h.
 */
export function resolveSessionId(
  projectRoot: string,
  explicit: string | undefined,
  now: number = Date.now(),
): { sessionId: string; source: "explicit" | "pointer"; stale: boolean } | null {
  if (explicit) {
    return { sessionId: explicit, source: "explicit", stale: false };
  }
  const pointer = readCurrentSession(projectRoot, now);
  if (!pointer) {
    return null;
  }
  return { sessionId: pointer.sessionId, source: "pointer", stale: pointer.stale };
}

/**
 * Print a stale-pointer warning to stderr. The warning is non-fatal.
 */
export function warnStalePointer(projectRoot: string, sessionId: string): void {
  const pointer = readCurrentSession(projectRoot);
  if (!pointer || !pointer.stale) return;
  const hours = Math.floor((Date.now() - pointer.mtime) / (60 * 60 * 1000));
  process.stderr.write(
    `cognit: warning — sticky session pointer points to ${sessionId} (mtime ${hours}h ago). ` +
      `Run \`cognit session list\` or pass \`--session <id>\` to disambiguate.\n`,
  );
}
