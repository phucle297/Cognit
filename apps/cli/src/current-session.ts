/**
 * Sticky current-session pointer — CLI facade over the shared
 * `@cognit/core/current-session`. The read/write/clear logic lives in
 * core so the DB inbox ingest path (`SessionService.ingest`) can reach
 * the same pointer; this wrapper only injects the CLI's stderr warning
 * for an invalid (non-ULID) pointer value, preserving the prior
 * user-facing behaviour.
 */

import {
  readCurrentSession as readCore,
  writeCurrentSession as writeCore,
  clearCurrentSession as clearCore,
  type ResolvedPointer,
} from "@cognit/core/current-session";

export type { ResolvedPointer };

const warnInvalid = (raw: string): void => {
  process.stderr.write(
    `cognit: warning — .cognit/current-session contains "${raw.length > 20 ? raw.slice(0, 20) + "…" : raw}" which is not a valid session id; ignoring.\n`,
  );
};

export function readCurrentSession(
  projectRoot: string,
  now: number = Date.now(),
): ResolvedPointer | null {
  return readCore(projectRoot, { now, onInvalid: warnInvalid });
}

export const writeCurrentSession = writeCore;
export const clearCurrentSession = clearCore;
