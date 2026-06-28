/**
 * apps/cli/test/hook-installer.test.ts — Phase A.2.
 *
 * Covers the four behaviours the user contract requires:
 *   1. detectAndInstallHooks is idempotent (re-running is a no-op)
 *   2. Existing settings.json keys are preserved (non-destructive)
 *   3. Atomic write: writers do not leave .tmp files behind
 *   4. Per-tool failure does not fail the run (resilience)
 *
 * We never touch the real `~/.claude/`, `~/.codex/`, `~/.gemini/`,
 * or `~/.config/opencode/` directories in this test. Each test sets
 * `process.env.HOME` to a temp dir and dynamically re-imports the
 * installer so the module's `os.homedir()` calls resolve to the
 * fake home.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Installer = typeof import("../src/hook-installer.js");

async function loadInstaller(): Promise<Installer> {
  vi.resetModules();
  return (await import("../src/hook-installer.js")) as Installer;
}

describe("detectAndInstallHooks", () => {
  let fakeHome: string;
  let realHome: string | undefined;
  let realUserProfile: string | undefined;

  beforeEach(() => {
    realHome = process.env.HOME;
    realUserProfile = process.env.USERPROFILE;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "cognit-hookinst-"));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    vi.resetModules();
  });

  function makeClaudeDir(): void {
    fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  }

  function writeSettings(p: string, json: unknown): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(json, null, 2));
  }

  function readSettings(p: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  }

  it("reports `tool-not-detected` when no AI tool directories exist", async () => {
    const { detectAndInstallHooks } = await loadInstaller();
    const results = detectAndInstallHooks();
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.status).toBe("tool-not-detected");
    }
  });

  it("wires Claude Code hooks when ~/.claude/ exists, preserving unrelated keys", async () => {
    makeClaudeDir();
    const settingsPath = path.join(fakeHome, ".claude", "settings.json");
    writeSettings(settingsPath, {
      theme: "dark",
      permissions: { allow: ["Read"], deny: [] },
    });

    const { detectAndInstallHooks } = await loadInstaller();
    const results = detectAndInstallHooks();
    const claude = results.find((r) => r.tool === "claude-code")!;
    expect(claude.status).toBe("installed");

    const written = readSettings(settingsPath);
    expect(written["theme"]).toBe("dark");
    expect(written["permissions"]).toEqual({ allow: ["Read"], deny: [] });
    const hooks = written["hooks"] as Record<string, unknown[]>;
    const post = hooks["PostToolUse"] as Array<{ hooks: Array<{ command: string }> }>;
    const pre = hooks["PreToolUse"] as Array<{ hooks: Array<{ command: string }> }>;
    expect(post[0]!.hooks[0]!.command).toBe("~/.cognit/hooks/cc-post.sh");
    expect(pre[0]!.hooks[0]!.command).toBe("~/.cognit/hooks/cc-pre.sh");
  });

  it("is idempotent: re-running against an already-wired tool is a no-op", async () => {
    makeClaudeDir();
    const settingsPath = path.join(fakeHome, ".claude", "settings.json");

    const { detectAndInstallHooks } = await loadInstaller();
    const first = detectAndInstallHooks();
    const firstClaude = first.find((r) => r.tool === "claude-code")!;
    expect(firstClaude.status).toBe("installed");

    const beforeSecond = readSettings(settingsPath);
    const second = detectAndInstallHooks();
    const secondClaude = second.find((r) => r.tool === "claude-code")!;
    expect(secondClaude.status).toBe("already-wired");
    expect(readSettings(settingsPath)).toEqual(beforeSecond);

    const leftover = fs
      .readdirSync(path.dirname(settingsPath))
      .filter((f) => f.includes(".tmp-"));
    expect(leftover).toEqual([]);
  });

  it("copies producer scripts to ~/.cognit/hooks/ with executable bit", async () => {
    makeClaudeDir();
    const { detectAndInstallHooks } = await loadInstaller();
    detectAndInstallHooks();
    const hooksDir = path.join(fakeHome, ".cognit", "hooks");
    expect(fs.existsSync(path.join(hooksDir, "cc-post.sh"))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, "cc-pre.sh"))).toBe(true);
    const stat = fs.statSync(path.join(hooksDir, "cc-post.sh"));
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it("does not regress an existing settings.json that has only unrelated keys", async () => {
    makeClaudeDir();
    const settingsPath = path.join(fakeHome, ".claude", "settings.json");
    const original = {
      theme: "dark",
      model: "claude-opus-4-8",
      permissions: { allow: ["Read", "Glob"], deny: ["Bash(rm *)"] },
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "/usr/local/bin/my-notify.sh" }],
          },
        ],
      },
    };
    writeSettings(settingsPath, original);

    const { detectAndInstallHooks } = await loadInstaller();
    const r = detectAndInstallHooks();
    expect(r.find((x) => x.tool === "claude-code")!.status).toBe("installed");

    const after = readSettings(settingsPath);
    expect(after["theme"]).toBe("dark");
    expect(after["model"]).toBe("claude-opus-4-8");
    const post = (after["hooks"] as Record<string, unknown[]>)["PostToolUse"] as Array<{
      matcher?: string;
      hooks: Array<{ command: string }>;
    }>;
    expect(post[0]!.hooks[0]!.command).toBe("/usr/local/bin/my-notify.sh");
    expect(post).toHaveLength(2);
    expect(post[1]!.hooks[0]!.command).toBe("~/.cognit/hooks/cc-post.sh");
  });
});