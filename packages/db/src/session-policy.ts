/**
 * SessionPolicy — runtime configuration for session-lifecycle behaviour.
 *
 * Two values travel together because they are both decisions about how
 * often we do "expensive" work for a session:
 *
 *   - `everyN`         — auto-snapshot after every N events on a session.
 *                        Default 100. Larger N = less I/O, longer
 *                        snapshot+tail replay windows. Smaller N =
 *                        more I/O, bounded replay.
 *   - `forkOnResume`   — when resuming a session, create a new
 *                        sessions row linked via `parent_session_id`
 *                        (true, default) or reopen the original in
 *                        place (false).
 *
 * The default layer (`SessionPolicyDefault`) ships sensible test
 * defaults: existing test suites that append <100 events per session
 * keep passing unchanged.
 *
 * `sessionPolicyFromConfig` is a pure helper that derives the policy
 * from the on-disk `cognit.yaml` `session` section. The CLI builds
 * this once at command entry, then threads the resulting `Layer`
 * into the app layer via `buildAppLayer(root, policy)`.
 */

import { Context, Layer } from "effect";
import type { CognitConfig } from "@cognit/core/config";

export interface SessionPolicyShape {
  readonly everyN: number;
  readonly forkOnResume: boolean;
}

export class SessionPolicy extends Context.Tag("@cognit/db/SessionPolicy")<
  SessionPolicy,
  SessionPolicyShape
>() {}

/** Defaults match `CognitConfig` (`packages/core/src/config.ts`). */
export const SessionPolicyDefault: Layer.Layer<SessionPolicy> = Layer.succeed(SessionPolicy)({
  everyN: 100,
  forkOnResume: true,
});

/**
 * Pure helper: derive a `SessionPolicyShape` from a parsed
 * `CognitConfig`. The schema (`packages/core/src/config.ts`) supplies
 * defaults for missing fields, so by the time this runs the `session`
 * section is fully populated — no fallbacks needed here.
 */
export const sessionPolicyFromConfig = (
  cfg: Pick<CognitConfig, "session">,
): SessionPolicyShape => ({
  everyN: cfg.session.snapshot_every_n_events,
  forkOnResume: cfg.session.fork_on_resume,
});
