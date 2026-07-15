/**
 * Lazy inbox drain for read commands (designs/D-M4-00 §1).
 *
 * Every read/turn command that builds the app layer (`continue`,
 * `search`, `events`) drains the inbox once before answering, so data
 * is fresh whenever it is consumed — with zero new processes. A missed
 * drain on one command is caught by the next; the pipeline is
 * self-healing.
 *
 * Best-effort: a drain failure is logged to stderr but never fails the
 * caller. A read command must still answer even if the drain hiccups.
 */

import { Effect } from "effect";
import { drainInbox, ProjectService, inboxFileCounts, type InboxWatcherConfig } from "@cognit/db";
import { projectPaths } from "./paths.js";
import { readConfig } from "./yaml-io.js";
import { withAppLayerAndConfig } from "./layer-build.js";

/**
 * Drain `.cognit/inbox/` once. Each file is funnelled through
 * `SessionService.ingest`, which auto-binds a session on the first
 * event (§2). Returns `{ processed, errored }`, or `null` when the
 * drain could not run (logged, non-fatal).
 */
export const drainInboxOnce = async (
  root: string,
): Promise<{ processed: number; errored: number } | null> => {
  try {
    const cfg = await readConfig(projectPaths(root).config);
    // §5: auto_drain=false opts out (e.g. when running --watch).
    if (cfg.inbox.auto_drain === false) return null;
    // §3.1: soft-cap warning before draining. Hard cap is intentionally
    // not enforced (silent drop violates local-first trust).
    const paths = projectPaths(root);
    const counts = await inboxFileCounts({ inboxDir: paths.inbox, errorDir: paths.inboxError });
    if (counts.pending > cfg.inbox.max_pending) {
      process.stderr.write(
        `cognit: inbox pending (${counts.pending}) exceeds soft cap ${cfg.inbox.max_pending}; draining now\n`,
      );
    }
    const projectName = cfg.project.name;
    const debounceMs = cfg.inbox.debounce_ms;
    const eff = Effect.gen(function* () {
      const projects = yield* ProjectService;
      const row = yield* projects.ensure({ name: projectName });
      const inboxConfig: InboxWatcherConfig = {
        inboxDir: projectPaths(root).inbox,
        processedDir: `${projectPaths(root).dir}/processed`,
        errorDir: projectPaths(root).inboxError,
        debounceMs,
        projectId: row.id,
        projectRoot: root,
      };
      return yield* drainInbox(inboxConfig);
    });
    const provided = await withAppLayerAndConfig(root, eff);
    return await Effect.runPromise(provided);
  } catch (e) {
    process.stderr.write(`cognit: inbox drain skipped (${(e as Error).message ?? String(e)})\n`);
    return null;
  }
};
