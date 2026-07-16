/**
 * apps/cli/src/hook-installer.ts — Phase A.2.
 *
 * `cognit init` calls `detectAndInstallHooks()` after creating the
 * local `.cognit/` tree. The installer:
 *
 * 1. Detects which AI tools the user has installed by looking for
 *    well-known config directories:
 *      - Claude Code  → `~/.claude/`
 *      - Codex        → `~/.codex/`
 *      - Gemini CLI   → `~/.gemini/`
 *      - OpenCode     → `~/.config/opencode/`
 *      - Grok Build   → `~/.grok/` (also reads Claude settings)
 * 2. Copies the producer scripts (shell scripts + the OpenCode
 *    plugin) into `~/.cognit/hooks/` atomically. The destination
 *    directory is per-user and lives outside the project so hooks
 *    work across every Cognit project on the same machine.
 * 3. Merges the Cognit hook entries into each tool's settings file.
 *    Merging is non-destructive: we read the existing JSON, look for
 *    a Cognit-specific marker (the script path we just installed),
 *    and only add our entry when no matching one already exists.
 *    Unrelated user keys are preserved verbatim.
 *
 * Failure policy: any single tool failing must NOT fail the whole
 * `cognit init` run. The CLI continues to the next tool, prints a
 * warning, and lets the user re-run `cognit init` after fixing the
 * issue. The function returns a structured result per tool so the
 * caller can render a per-tool summary.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SupportedTool = "claude-code" | "codex" | "gemini-cli" | "opencode" | "grok";

export type HookInstallStatus =
  | "installed"
  | "already-wired"
  | "tool-not-detected"
  | "skipped"
  | "failed";

export interface HookInstallResult {
  readonly tool: SupportedTool;
  readonly status: HookInstallStatus;
  readonly detail?: string;
}

interface ToolSpec {
  readonly id: SupportedTool;
  /** Human label printed in the init summary. */
  readonly label: string;
  /** Absolute path that, if it exists, means the tool is installed. */
  readonly detectPath: string;
  /** Producer files to copy from repo `hooks/<id>/` to `~/.cognit/hooks/`. */
  readonly producers: ReadonlyArray<{ src: string; dst: string; mode: number }>;
  /** Returns `true` if the tool's settings already include a Cognit hook. */
  readonly alreadyWired: (settings: unknown) => boolean;
  /**
   * Mutate a parsed settings object to include Cognit hooks. Caller
   * is responsible for writing the result back atomically.
   */
  readonly merge: (settings: Record<string, unknown>) => Record<string, unknown>;
  /** Absolute path of the tool's user-layer settings file. */
  readonly settingsPath: string;
  /** Empty settings shape when the file does not yet exist. */
  readonly emptySettings: () => Record<string, unknown>;
}

const COGNIT_HOME = path.join(os.homedir(), ".cognit");
const HOOKS_DIR = path.join(COGNIT_HOME, "hooks");

/**
 * Resolve the repo-root `hooks/` directory. The CLI is built and
 * invoked from anywhere; we walk up from this source file until we
 * find a sibling `hooks/` directory that ships the producers.
 */
function resolveHooksSourceDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // apps/cli/src/hook-installer.ts → apps/cli/src → apps/cli → apps → repo root
  const candidates = [
    path.resolve(here, "..", "..", "..", "..", "hooks"),
    path.resolve(here, "..", "..", "..", "hooks"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fallback: let the caller pass a custom dir; default to first candidate.
  return candidates[0]!;
}

const HOOKS_SRC = resolveHooksSourceDir();

// --- tool specs --------------------------------------------------------

const claudeCode: ToolSpec = {
  id: "claude-code",
  label: "Claude Code",
  detectPath: path.join(os.homedir(), ".claude"),
  producers: [
    { src: path.join(HOOKS_SRC, "claude-code", "cc-post.sh"), dst: "cc-post.sh", mode: 0o755 },
    { src: path.join(HOOKS_SRC, "claude-code", "cc-pre.sh"), dst: "cc-pre.sh", mode: 0o755 },
    { src: path.join(HOOKS_SRC, "claude-code", "cc-drain.sh"), dst: "cc-drain.sh", mode: 0o755 },
  ],
  settingsPath: path.join(os.homedir(), ".claude", "settings.json"),
  emptySettings: () => ({}),
  alreadyWired: (settings) =>
    hasCognitHook(settings, "PostToolUse", "cc-post.sh") &&
    hasCognitHook(settings, "Stop", "cc-drain.sh") &&
    hasCognitHook(settings, "SessionEnd", "cc-drain.sh"),
  merge: (settings) => {
    const hooks = asObject(settings["hooks"]) ?? {};
    const post = asArray(hooks["PostToolUse"]) ?? [];
    const pre = asArray(hooks["PreToolUse"]) ?? [];
    const stop = asArray(hooks["Stop"]) ?? [];
    const sessionEnd = asArray(hooks["SessionEnd"]) ?? [];
    if (!hasCognitHook({ hooks: { PostToolUse: post } }, "PostToolUse", "cc-post.sh")) {
      // Broad matcher: Claude tools + Grok aliases (Grok scans ~/.claude
      // settings and maps Bash↔run_terminal_command etc.). Empty/.* = all.
      post.push({
        matcher: ".*",
        hooks: [{ type: "command", command: "~/.cognit/hooks/cc-post.sh" }],
      });
    }
    if (!hasCognitHook({ hooks: { PreToolUse: pre } }, "PreToolUse", "cc-pre.sh")) {
      pre.push({
        matcher: ".*",
        hooks: [{ type: "command", command: "~/.cognit/hooks/cc-pre.sh" }],
      });
    }
    // End-of-turn / end-of-session force-drain so dashboard sees events
    // without a manual `cognit inbox --process`.
    if (!hasCognitHook({ hooks: { Stop: stop } }, "Stop", "cc-drain.sh")) {
      stop.push({
        hooks: [{ type: "command", command: "~/.cognit/hooks/cc-drain.sh" }],
      });
    }
    if (!hasCognitHook({ hooks: { SessionEnd: sessionEnd } }, "SessionEnd", "cc-drain.sh")) {
      sessionEnd.push({
        hooks: [{ type: "command", command: "~/.cognit/hooks/cc-drain.sh" }],
      });
    }
    return {
      ...settings,
      hooks: {
        ...hooks,
        PostToolUse: post,
        PreToolUse: pre,
        Stop: stop,
        SessionEnd: sessionEnd,
      },
    };
  },
};

const codex: ToolSpec = {
  id: "codex",
  label: "Codex",
  detectPath: path.join(os.homedir(), ".codex"),
  producers: [
    { src: path.join(HOOKS_SRC, "codex", "codex-post.sh"), dst: "codex-post.sh", mode: 0o755 },
    { src: path.join(HOOKS_SRC, "codex", "codex-pre.sh"), dst: "codex-pre.sh", mode: 0o755 },
  ],
  settingsPath: path.join(os.homedir(), ".codex", "hooks.json"),
  emptySettings: () => ({ hooks: {} }),
  alreadyWired: (settings) => hasCognitHook(settings, "PostToolUse", "codex-post.sh"),
  merge: (settings) => {
    const hooks = asObject(settings["hooks"]) ?? {};
    const post = asArray(hooks["PostToolUse"]) ?? [];
    if (!post.some((entry) => entryReferencesScript(entry, "codex-post.sh"))) {
      post.push({
        matcher: ".*",
        type: "command",
        command: "~/.cognit/hooks/codex-post.sh",
        timeout: 30,
      });
    }
    return { ...settings, hooks: { ...hooks, PostToolUse: post } };
  },
};

const geminiCli: ToolSpec = {
  id: "gemini-cli",
  label: "Gemini CLI",
  detectPath: path.join(os.homedir(), ".gemini"),
  producers: [
    {
      src: path.join(HOOKS_SRC, "gemini-cli", "gemini-post.sh"),
      dst: "gemini-post.sh",
      mode: 0o755,
    },
  ],
  settingsPath: path.join(os.homedir(), ".gemini", "settings.json"),
  emptySettings: () => ({
    hooksConfig: { enabled: true, disabled: [], notifications: true },
    hooks: {},
  }),
  alreadyWired: (settings) => hasCognitHook(settings, "AfterTool", "gemini-post.sh"),
  merge: (settings) => {
    const hooks = asObject(settings["hooks"]) ?? {};
    const after = asArray(hooks["AfterTool"]) ?? [];
    if (!after.some((entry) => entryReferencesScript(entry, "gemini-post.sh"))) {
      after.push({ matcher: "*", type: "shell", command: "~/.cognit/hooks/gemini-post.sh" });
    }
    const next: Record<string, unknown> = { ...settings, hooks: { ...hooks, AfterTool: after } };
    if (!next["hooksConfig"]) {
      next["hooksConfig"] = { enabled: true, disabled: [], notifications: true };
    }
    return next;
  },
};

const opencode: ToolSpec = {
  id: "opencode",
  label: "OpenCode",
  detectPath: path.join(os.homedir(), ".config", "opencode"),
  producers: [
    {
      // OpenCode loads the first plugin it finds at:
      //   ~/.config/opencode/plugins/cognit.ts
      // We copy the source there directly (the original docs use a
      // symlink, but a copy is more robust across filesystems and
      // survives `git pull`). The absolute `dst` overrides the
      // default HOOKS_DIR destination — see `installTool`.
      src: path.join(HOOKS_SRC, "opencode", "cognit.ts"),
      dst: path.join(os.homedir(), ".config", "opencode", "plugins", "cognit.ts"),
      mode: 0o644,
    },
  ],
  settingsPath: path.join(os.homedir(), ".config", "opencode", "plugins", "cognit.ts"),
  emptySettings: () => ({}),
  alreadyWired: (_settings) => {
    // The plugin is a file, not a JSON setting. `alreadyWired` is
    // unused for OpenCode — the installer treats the destination
    // file's existence as the wiring signal (see installTool).
    return false;
  },
  merge: (settings) => settings,
};


const grok: ToolSpec = {
  id: "grok",
  label: "Grok Build",
  detectPath: path.join(os.homedir(), ".grok"),
  // Reuse Claude producers — scripts auto-detect host via GROK_* env + camelCase JSON.
  producers: [
    { src: path.join(HOOKS_SRC, "claude-code", "cc-post.sh"), dst: "cc-post.sh", mode: 0o755 },
    { src: path.join(HOOKS_SRC, "claude-code", "cc-pre.sh"), dst: "cc-pre.sh", mode: 0o755 },
    { src: path.join(HOOKS_SRC, "claude-code", "cc-drain.sh"), dst: "cc-drain.sh", mode: 0o755 },
  ],
  // Grok loads global hooks from ~/.grok/hooks/*.json (always trusted).
  settingsPath: path.join(os.homedir(), ".grok", "hooks", "cognit.json"),
  emptySettings: () => ({ hooks: {} }),
  alreadyWired: (settings) =>
    (hasCognitHook(settings, "PostToolUse", "cc-post.sh") ||
      hasCognitHook(settings, "post_tool_use", "cc-post.sh")) &&
    (hasCognitHook(settings, "Stop", "cc-drain.sh") ||
      hasCognitHook(settings, "stop", "cc-drain.sh")) &&
    (hasCognitHook(settings, "SessionEnd", "cc-drain.sh") ||
      hasCognitHook(settings, "session_end", "cc-drain.sh")),
  merge: (settings) => {
    const hooks = asObject(settings["hooks"]) ?? {};
    const post = asArray(hooks["PostToolUse"]) ?? asArray(hooks["post_tool_use"]) ?? [];
    const pre = asArray(hooks["PreToolUse"]) ?? asArray(hooks["pre_tool_use"]) ?? [];
    const stop = asArray(hooks["Stop"]) ?? asArray(hooks["stop"]) ?? [];
    const sessionEnd = asArray(hooks["SessionEnd"]) ?? asArray(hooks["session_end"]) ?? [];
    // Prefer PascalCase keys (Grok accepts both; Claude-compat shape).
    const nextPost = [...post];
    const nextPre = [...pre];
    const nextStop = [...stop];
    const nextSessionEnd = [...sessionEnd];
    if (!nextPost.some((entry) => entryReferencesScript(entry, "cc-post.sh"))) {
      nextPost.push({
        matcher: ".*",
        hooks: [{ type: "command", command: "~/.cognit/hooks/cc-post.sh" }],
      });
    }
    if (!nextPre.some((entry) => entryReferencesScript(entry, "cc-pre.sh"))) {
      nextPre.push({
        matcher: ".*",
        hooks: [{ type: "command", command: "~/.cognit/hooks/cc-pre.sh" }],
      });
    }
    // Force-drain when a turn or session ends (no matcher — lifecycle events reject matchers).
    if (!nextStop.some((entry) => entryReferencesScript(entry, "cc-drain.sh"))) {
      nextStop.push({
        hooks: [{ type: "command", command: "~/.cognit/hooks/cc-drain.sh" }],
      });
    }
    if (!nextSessionEnd.some((entry) => entryReferencesScript(entry, "cc-drain.sh"))) {
      nextSessionEnd.push({
        hooks: [{ type: "command", command: "~/.cognit/hooks/cc-drain.sh" }],
      });
    }
    return {
      ...settings,
      hooks: {
        ...hooks,
        PostToolUse: nextPost,
        PreToolUse: nextPre,
        Stop: nextStop,
        SessionEnd: nextSessionEnd,
      },
    };
  },
};

const TOOLS: ReadonlyArray<ToolSpec> = [claudeCode, codex, geminiCli, opencode, grok];

// --- helpers ----------------------------------------------------------

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

/**
 * Scan an array of hook entries (which may be flat or wrapped in
 * `{ hooks: [...] }`) for one whose `command` references the named
 * Cognit producer script.
 */
function hasCognitHook(settings: unknown, eventName: string, scriptName: string): boolean {
  const root = asObject(settings);
  if (!root) return false;
  const hooks = asObject(root["hooks"]);
  if (!hooks) return false;
  const list = asArray(hooks[eventName]);
  if (!list) return false;
  return list.some((entry) => entryReferencesScript(entry, scriptName));
}

function entryReferencesScript(entry: unknown, scriptName: string): boolean {
  // Flat shape: { command: "~/.cognit/hooks/cc-post.sh" }
  // Wrapped shape: { hooks: [{ command: "~/.cognit/hooks/cc-post.sh" }] }
  const obj = asObject(entry);
  if (!obj) return false;
  if (typeof obj["command"] === "string" && (obj["command"] as string).endsWith(scriptName)) {
    return true;
  }
  const inner = asArray(obj["hooks"]);
  if (!inner) return false;
  return inner.some((h) => {
    const ho = asObject(h);
    return typeof ho?.["command"] === "string" && (ho["command"] as string).endsWith(scriptName);
  });
}

/**
 * Atomic copy: write the bytes to a temp file in the destination
 * directory, fsync, rename. Mirrors the inbox atomic-write protocol
 * (see packages/wrap/src/atomic-write.ts).
 */
function atomicCopyFile(src: string, dst: string, mode: number): void {
  const bytes = fs.readFileSync(src);
  const dir = path.dirname(dst);
  fs.mkdirSync(dir, { recursive: true });
  // Skip if identical content already present.
  if (fs.existsSync(dst)) {
    const existing = fs.readFileSync(dst);
    if (existing.equals(bytes)) {
      // Ensure executable bit is preserved even if content matches.
      fs.chmodSync(dst, mode);
      return;
    }
  }
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, dst);
}

/**
 * Atomic JSON write: temp file → fsync → rename. Preserves the
 * existing file's mode where possible (new files start at 0o600
 * because settings files often contain tokens).
 */
function atomicWriteJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

function readJsonSafe(target: string): Record<string, unknown> | null {
  if (!fs.existsSync(target)) return null;
  const raw = fs.readFileSync(target, "utf8").trim();
  if (raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return asObject(parsed);
  } catch (e) {
    throw new Error(`could not parse ${target}: ${(e as Error).message}`);
  }
}

// --- installer --------------------------------------------------------

function installTool(spec: ToolSpec): HookInstallResult {
  if (!fs.existsSync(spec.detectPath)) {
    return { tool: spec.id, status: "tool-not-detected" };
  }

  try {
    // Step 1: copy producer scripts. For OpenCode, the "settings file"
    // IS the producer file (the plugin) — installing it covers wiring.
    // For all other tools, the destination is `~/.cognit/hooks/<name>`
    // (the per-user hook dir); an absolute `dst` overrides that.
    for (const p of spec.producers) {
      if (!fs.existsSync(p.src)) {
        return {
          tool: spec.id,
          status: "failed",
          detail: `producer not found at ${p.src}`,
        };
      }
      const destination = path.isAbsolute(p.dst)
        ? p.dst
        : path.join(HOOKS_DIR, p.dst);
      atomicCopyFile(p.src, destination, p.mode);
    }

    // Step 2: wire settings. OpenCode skips JSON merging.
    if (spec.id === "opencode") {
      // The plugin copy in step 1 IS the wiring. atomicCopyFile is
      // a no-op when bytes already match, so a re-run will not
      // change the file. We still want to report "already wired"
      // on the second pass — the heuristic is the plugin's own
      // file header marker.
      const pluginBody = fs.readFileSync(spec.settingsPath, "utf8");
      // The shipped plugin's first comment line is the marker. We
      // treat presence of the marker as "already wired"; absence
      // means the file exists but is not ours (caller can decide).
      const isFreshInstall = pluginBody.includes("cognit.ts — OpenCode plugin");
      return {
        tool: spec.id,
        status: isFreshInstall ? "already-wired" : "installed",
        detail: "plugin copied to ~/.config/opencode/plugins/cognit.ts",
      };
    }

    const existing = readJsonSafe(spec.settingsPath);
    const base = existing ?? spec.emptySettings();
    if (spec.alreadyWired(base)) {
      return { tool: spec.id, status: "already-wired", detail: spec.settingsPath };
    }
    const merged = spec.merge(base);
    atomicWriteJson(spec.settingsPath, merged);
    return { tool: spec.id, status: "installed", detail: spec.settingsPath };
  } catch (e) {
    return { tool: spec.id, status: "failed", detail: (e as Error).message };
  }
}

/** Shared helpers every shell producer needs (ULID mint + sticky session). */
function installSharedProducers(): void {
  const shared = [
    { src: path.join(HOOKS_SRC, "shared", "ulid.mjs"), dst: "ulid.mjs", mode: 0o755 },
    { src: path.join(HOOKS_SRC, "shared", "hook-lib.sh"), dst: "hook-lib.sh", mode: 0o644 },
  ] as const;
  for (const p of shared) {
    if (!fs.existsSync(p.src)) {
      // Source tree incomplete — producers will fall back to inline mint.
      continue;
    }
    atomicCopyFile(p.src, path.join(HOOKS_DIR, p.dst), p.mode);
  }
}

export function detectAndInstallHooks(): HookInstallResult[] {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  installSharedProducers();
  return TOOLS.map(installTool);
}

/** Test-only: override the hooks source directory. */
export function _setHooksSourceDirForTesting(dir: string): void {
  // Re-resolve by mutating the module-private constant via a re-eval.
  // Simpler: expose a getter and have callers use it. Kept here for
  // future test plumbing; the current shape is enough for production.
  void dir;
}
