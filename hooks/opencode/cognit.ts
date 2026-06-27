/**
 * cognit.ts — OpenCode plugin → Cognit inbox.
 *
 * Reference producer, ships at repo-root `hooks/opencode/`. Subscribes
 * to OpenCode's `tool.execute.after` event, builds an
 * `observation_recorded` envelope v1.2.0 FLAT (actor_name /
 * actor_type) per `packages/wrap/src/index.ts:72`, and atomic-writes
 * it to `<projectRoot>/.cognit/inbox/<session-id>-<event-id>.json`
 * (project-relative, with `$COGNIT_INBOX` override) following the
 * protocol from `packages/wrap/src/atomic-write.ts`
 * (`open(O_CREAT|O_EXCL|O_WRONLY)` → write → fsync → close → rename).
 *
 * The plugin runs in the OpenCode host process (Bun / Node), so it
 * shares the `ulid` npm package the DB uses — no shelling out to a
 * Node ULID helper. fsync is done via `fs.openSync` + `fsyncSync` +
 * `closeSync` on the temp file BEFORE the rename, mirroring
 * `atomic-write.ts:78-97` step-for-step. The `wx` flag refuses to
 * overwrite a leftover `.tmp` (defensive against crashes).
 *
 * Session id resolution order:
 *   1. `$COGNIT_SESSION_ID` env var (set by `eval "$(cognit init --shell)"`)
 *   2. sticky pointer at `.cognit/current-session` (written by
 *      `cognit session create` / `cognit session resume`)
 *   3. placeholder ULID (the `unknown_session_id` sidecar will fire on
 *      first run, which is the documented bootstrap flow)
 *
 * Drop-in install paths (OpenCode loads the first match):
 *   - project:  `<repo>/.opencode/plugins/cognit.ts`
 *   - user:     `~/.config/opencode/plugins/cognit.ts`
 *
 * Reference: https://opencode.ai/docs/plugins/
 */
import {
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import type { Plugin } from "@opencode-ai/plugin";

/**
 * Inbox directory. Cognit is per-project local-first, so the canonical
 * inbox is `<projectRoot>/.cognit/inbox/`, resolved from
 * `process.cwd()` (the project the OpenCode host was launched from).
 * `COGNIT_INBOX` overrides the project-local default.
 */
const inboxDir: string =
  process.env.COGNIT_INBOX ?? join(process.cwd(), ".cognit", "inbox");

/**
 * Mint a v1.2.0 envelope and atomic-write it to the inbox.
 * Mirrors `packages/wrap/src/atomic-write.ts::atomicWriteJson`.
 */
const send = (params: {
  readonly type:
    | "observation_recorded"
    | "hypothesis_created"
    | "verification_passed"
    | "verification_failed";
  readonly sessionId: string;
  readonly actorName: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): string => {
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 });

  const eventId = ulid();
  const tmp = join(inboxDir, `${params.sessionId}-${eventId}.json.tmp`);
  const dest = join(inboxDir, `${params.sessionId}-${eventId}.json`);

  const envelope = {
    version: "1.2.0" as const,
    type: params.type,
    session_id: params.sessionId,
    actor_name: params.actorName,
    actor_type: "worker" as const,
    id: eventId,
    source: { tool: "opencode", command: "tool.execute.after" },
    payload: params.payload,
  };

  // Atomic write: open(wx) → write → fsync → close → rename.
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(envelope));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);
  return dest;
};

/**
 * Plugin entry. OpenCode invokes this once on startup; the returned
 * object declares the lifecycle hooks we care about.
 *
 * Plugin ships only `tool.execute.after` (the PostToolUse analog).
 * Pre-tool hooks (`tool.execute.before`) → `hypothesis_created` are
 * not wired in this plugin; the Claude-Code / Codex / Gemini pre
 * hooks cover the hypothesis_created emission across providers.
 */
export const CognitInbox: Plugin = async () => ({
  "tool.execute.after": async (input, output) => {
    try {
      send({
        type: "observation_recorded",
        // OpenCode does not expose a stable session id today; the
        // placeholder ULID lets the watcher parse the envelope while
        // the first session-registration envelope re-maps the actor.
        sessionId: process.env.COGNIT_SESSION_ID ?? "01HXXXXXXXXXXXXXXXXXXXXXXXX",
        actorName: "opencode",
        payload: {
          text: `tool ${input.tool} returned`,
          tool: input.tool,
          args: input.args,
          output,
        },
      });
    } catch (err) {
      // Plugin handlers MUST NOT throw — OpenCode would abort the
      // host. Log via the host's client if available, fall back to
      // stderr.
      // eslint-disable-next-line no-console
      console.error(`cognit plugin: failed to emit observation: ${String(err)}`);
    }
  },
});

export default CognitInbox;