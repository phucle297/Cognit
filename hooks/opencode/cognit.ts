/**
 * cognit.ts — OpenCode plugin → Cognit inbox.
 *
 * Session id: COGNIT_SESSION_ID → .cognit/current-session → mint + stick.
 * Event id: pure Crockford ULID (no npm `ulid` dependency).
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

  const eventId = mintUlid();
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

  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(envelope));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);

  if (process.env.COGNIT_REALTIME === "1") {
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
      send({
        type: "observation_recorded",
        sessionId: resolveSessionId(),
        actorName: "opencode",
        payload: {
          text: `tool ${input.tool} returned`,
          tool: input.tool,
          args: input.args,
          output,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`cognit plugin: failed to emit observation: ${String(err)}`);
    }
  },
});

export default CognitInbox;
