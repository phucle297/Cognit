/**
 * cognit.ts — OpenCode plugin → Cognit inbox.
 *
 * Session id: COGNIT_SESSION_ID → .cognit/current-session → mint + stick.
 * Event id: pure Crockford ULID (no npm `ulid` dependency).
 * Emits `raw_tool_signal` v1.3.0 (evidence only; ingest Phase 2b classifies).
 */
import {
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const encodeTime = (now: number, len = 10): string => {
  let t = now;
  let out = "";
  for (let i = len; i > 0; i--) {
    const mod = t % 32;
    out = ENCODING[mod]! + out;
    t = Math.floor(t / 32);
  }
  return out;
};

const encodeRandom = (len = 16): string => {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ENCODING[bytes[i]! & 31];
  return out;
};

const mintUlid = (): string => encodeTime(Date.now()) + encodeRandom();

const resolveActorName = (sessionId: string): string => {
  const hash = sessionId.length >= 6 ? sessionId.slice(-6) : "000000";
  const raw =
    process.env.COGNIT_MODEL?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    process.env.LITELLM_MODEL?.trim() ||
    "opencode";
  const short = raw
    .toLowerCase()
    .replace(/[^a-z0-9._+-]/g, "")
    .slice(0, 40) || "opencode";
  return `${short}+${hash}`;
};


const projectRoot = (): string => process.cwd();
const cognitDir = (): string => join(projectRoot(), ".cognit");
const stickyPath = (): string => join(cognitDir(), "current-session");

const resolveSessionId = (): string => {
  const env = process.env.COGNIT_SESSION_ID?.trim() ?? "";
  if (ULID_RE.test(env)) return env;
  try {
    if (existsSync(stickyPath())) {
      const s = readFileSync(stickyPath(), "utf8").trim();
      if (ULID_RE.test(s)) return s;
    }
  } catch {
    /* ignore */
  }
  const s = mintUlid();
  mkdirSync(cognitDir(), { recursive: true, mode: 0o700 });
  const tmp = join(cognitDir(), `current-session.tmp.${process.pid}`);
  writeFileSync(tmp, s, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, stickyPath());
  return s;
};

const inboxDir: string =
  process.env.COGNIT_INBOX ?? join(projectRoot(), ".cognit", "inbox");

const send = (params: {
  readonly type: "raw_tool_signal";
  readonly sessionId: string;
  readonly actorName: string;
  readonly sourceCommand: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): string => {
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 });

  const eventId = mintUlid();
  const tmp = join(inboxDir, `${params.sessionId}-${eventId}.json.tmp`);
  const dest = join(inboxDir, `${params.sessionId}-${eventId}.json`);

  const envelope = {
    version: "1.3.0" as const,
    type: params.type,
    session_id: params.sessionId,
    actor_name: params.actorName,
    actor_type: "worker" as const,
    id: eventId,
    source: { tool: "opencode", command: params.sourceCommand },
    payload: params.payload,
  };

  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(envelope));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);

  // Agent OOB drain (default ON). Opt-out: COGNIT_REALTIME=0.
  // Mirrors hooks/shared/hook-lib.sh cognits_maybe_drain.
  const rt = (process.env.COGNIT_REALTIME ?? "").toLowerCase();
  const optedOut = rt === "0" || rt === "false" || rt === "no" || rt === "off";
  if (!optedOut) {
    try {
      const child = spawn("cognit", ["inbox", "--process"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch {
      /* optional */
    }
  }

  return dest;
};

export const CognitInbox: Plugin = async () => ({
  "tool.execute.after": async (input, output) => {
    try {
      const sessionId = resolveSessionId();
      const tool = String(input.tool ?? "unknown");
      const args = (input.args ?? {}) as Record<string, unknown>;
      const pathVal =
        (typeof args.file_path === "string" && args.file_path) ||
        (typeof args.filePath === "string" && args.filePath) ||
        (typeof args.path === "string" && args.path) ||
        null;
      const commandVal =
        (typeof args.command === "string" && args.command) ||
        (typeof args.cmd === "string" && args.cmd) ||
        null;
      send({
        type: "raw_tool_signal",
        sessionId,
        actorName: resolveActorName(sessionId),
        sourceCommand: "tool.execute.after",
        payload: {
          phase: "post",
          host: "opencode",
          tool,
          tool_input: args,
          tool_response: output,
          text: pathVal
            ? `tool ${tool} → ${pathVal}`
            : commandVal
              ? `tool ${tool}: ${String(commandVal).slice(0, 200)}`
              : `tool ${tool} returned`,
          path: pathVal,
          command: commandVal,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`cognit plugin: failed to emit raw_tool_signal: ${String(err)}`);
    }
  },
});

export default CognitInbox;
