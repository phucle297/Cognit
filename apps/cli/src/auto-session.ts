/**
 * apps/cli/src/auto-session.ts — resolve or auto-create a session.
 *
 * Used by every command that writes an event (`observation`, `decision`,
 * `conclusion`, `verification`, `append`). The M1 contract:
 *
 *   - `--session <id>` (if passed) wins.
 *   - Otherwise read `.cognit/current-session`. If it points at an
 *     active or paused session, reuse it.
 *   - Otherwise create a new session with goal = first non-empty
 *     positional argument, or `cognit-cli @ <iso>` if no arg.
 *   - Update the sticky pointer.
 *   - Return the id.
 *
 * The user never has to run `cognit session create`. Claude Code can
 * fire `cognit observation "..."` straight away.
 */

import { Effect, Exit, Cause } from "effect";
import path from "node:path";
import {
  ProjectService,
  SessionService,
  type ActorType,
} from "@cognit/db";
import { findProjectRoot, projectPaths } from "./paths.js";
import { readConfig } from "./yaml-io.js";
import { readCurrentSession, writeCurrentSession } from "./current-session.js";
import { warnStalePointer } from "./session-resolver.js";
import { withAppLayer } from "./layer-build.js";

export interface AutoSessionResult {
  readonly sessionId: string;
  readonly created: boolean;
}

interface EnsureInput {
  readonly root: string;
  readonly explicit?: string;
  readonly goalHint?: string;
  readonly actor: { readonly name: string; readonly type: ActorType };
}

/**
 * Resolve a project row from the on-disk config. Mirrors the pattern
 * in `session.ts` but kept private here so commands don't reach into
 * the same helper.
 */
const loadProjectId = async (
  root: string,
): Promise<{ id: string; name: string }> =>
  Effect.runPromise(
    withAppLayer(
      root,
      Effect.gen(function* () {
        const cfg = yield* Effect.tryPromise({
          try: () => readConfig(projectPaths(root).config),
          catch: (e) => new Error(`readConfig: ${(e as Error).message}`),
        });
        const projects = yield* ProjectService;
        const row = yield* projects.ensure({ name: cfg.project.name });
        return { id: row.id, name: row.name };
      }),
    ),
  );

/**
 * Look up a session by id; return null when missing/closed.
 */
const probeSession = async (
  root: string,
  sessionId: string,
): Promise<"active" | "paused" | "closed" | null> =>
  Effect.runPromise(
    withAppLayer(
      root,
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        try {
          const r = yield* sessions.show(sessionId);
          return r.session.status;
        } catch (_e) {
          return null;
        }
      }),
    ),
  ).catch(() => null as "active" | "paused" | "closed" | null);

/**
 * Create a new session and write the sticky pointer.
 */
const createSession = async (
  root: string,
  projectId: string,
  goal: string,
  actor: { readonly name: string; readonly type: ActorType },
): Promise<string> => {
  const exit = await Effect.runPromiseExit(
    withAppLayer(
      root,
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const r = yield* sessions.create({
          projectId,
          goal,
          parentSessionId: null,
          actor,
        });
        return r.session.id;
      }),
    ),
  );
  if (Exit.isFailure(exit)) {
    const cause = Cause.failureOption(exit.cause);
    const msg =
      cause._tag === "Some"
        ? ((cause.value as { message?: string }).message ?? String(cause.value))
        : "create session failed";
    throw new Error(msg);
  }
  return exit.value;
};

/**
 * The main entry point. Returns `{ sessionId, created }`. Never
 * prints to stdout/stderr — the caller decides the user-facing line.
 *
 * `goalHint` is the first non-flag arg from the command (e.g. the
 * observation text). Used as the new session goal when we have to
 * create one; otherwise a timestamped placeholder.
 */
export async function ensureSession(input: EnsureInput): Promise<AutoSessionResult> {
  const { root, explicit, goalHint, actor } = input;

  // 1. Explicit --session wins. Validate it points at an open session;
  //    if not, fall through to create a new one (don't fail the user
  //    for an unknown id — Claude Code may pass a stale id after a
  //    context switch).
  //
  //    IMPORTANT: we do NOT clobber the sticky pointer on the explicit
  //    path. An explicit --session is treated as a one-off override;
  //    the user's most recent `session create` / `cognit continue` /
  //    implicit auto-create stays sticky for subsequent commands.
  if (explicit) {
    const status = await probeSession(root, explicit);
    if (status === "active" || status === "paused") {
      return { sessionId: explicit, created: false };
    }
  }

  // 2. Sticky pointer.
  const pointer = readCurrentSession(root);
  if (pointer) {
    const status = await probeSession(root, pointer.sessionId);
    if (status === "active" || status === "paused") {
      if (pointer.stale) warnStalePointer(root, pointer.sessionId);
      return { sessionId: pointer.sessionId, created: false };
    }
  }

  // 3. Create.
  const project = await loadProjectId(root);
  const goal =
    goalHint && goalHint.trim().length > 0
      ? goalHint.slice(0, 200)
      : `cognit-cli @ ${new Date().toISOString()}`;
  const sessionId = await createSession(root, project.id, goal, actor);
  writeCurrentSession(root, sessionId);
  return { sessionId, created: true };
}

/**
 * Convenience: find the project root, fail with a friendly message if
 * outside a project. Avoids repeating the boilerplate in every command.
 */
export function requireProjectRoot(): string {
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write(
      "cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n",
    );
    process.exitCode = 2;
    throw new Error("not in a cognit project");
  }
  return root;
}

/** Re-export the cwd helper for callers that want a default goal hint. */
export const cwdProjectHint = (): string => path.basename(process.cwd());
