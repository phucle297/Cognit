/**
 * apps/cli/src/supervisor.ts — D-M4-00 Phase 4.2.
 *
 * Generates user-mode supervisor unit files that run
 * `cognit inbox --watch` as a supervised long-lived process:
 *   - systemd on Linux (user mode, `default.target`)
 *   - launchd on macOS (`~/Library/LaunchAgents/`)
 *
 * Values are interpolated directly into unit text, so `workingDir` is
 * validated to be an absolute path with no newlines (a single unescaped
 * newline would terminate a unit-file line or break the plist). This is
 * the only trust boundary here — `cognitPath` is expected to be a bare
 * binary name or an absolute path chosen by the caller, not user HTTP
 * input. The generator never touches the filesystem; the caller decides
 * where (and whether) to write.
 */

import os from "node:os";
import path from "node:path";

/** Inputs for unit generation. */
export interface SupervisorUnitOpts {
  /** Absolute directory `cognit inbox --watch` runs in. */
  readonly workingDir: string;
  /** Binary to invoke. Defaults to `"cognit"` (resolved on `$PATH`). */
  readonly cognitPath?: string;
  /** Human description for the unit. Defaults to a Cognit string. */
  readonly description?: string;
}

export type SupervisorPlatform = "systemd" | "launchd" | "unknown";

/** Detects the host's supervisor family from `process.platform`. */
export function detectPlatform(): SupervisorPlatform {
  // ponytail: process.platform is the standard signal; we don't try to
  // sniff systemd-vs-sysvinit because Cognit only emits unit text and
  // lets the user decide where to install it.
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") return "systemd";
  return "unknown";
}

/**
 * Throws if `workingDir` is not a safe value to interpolate into unit
 * text. Absolute + no control chars is the contract; we don't need to
 * escape for a shell because neither systemd nor launchd invoke a shell
 * for `ExecStart`/`ProgramArguments`.
 */
function assertSafeWorkingDir(workingDir: string): void {
  if (!path.isAbsolute(workingDir)) {
    throw new Error(
      `workingDir must be an absolute path, got: ${JSON.stringify(workingDir)}`,
    );
  }
  if (/[\r\n\0]/.test(workingDir)) {
    throw new Error("workingDir must not contain newlines or NUL bytes");
  }
}

/** Minimal XML escaping for plist string values. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Renders a user-mode systemd unit. Runs as the current user (no root,
 * no `User=` directive) and restarts on failure with a 5s backoff.
 */
export function generateSystemdUnit(opts: SupervisorUnitOpts): string {
  assertSafeWorkingDir(opts.workingDir);
  const cognit = opts.cognitPath ?? "cognit";
  const description = opts.description ?? "Cognit inbox watcher";
  return [
    "[Unit]",
    `Description=${description}`,
    "",
    "[Service]",
    `WorkingDirectory=${opts.workingDir}`,
    `ExecStart=${cognit} inbox --watch`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * Renders a launchd plist. `RunAtLoad` starts it immediately, `KeepAlive`
 * restarts on exit. Logs go under `~/.cognit/logs/` (created by the
 * caller if missing).
 */
export function generateLaunchdUnit(opts: SupervisorUnitOpts): string {
  assertSafeWorkingDir(opts.workingDir);
  const cognit = opts.cognitPath ?? "cognit";
  const description = opts.description ?? "Cognit inbox watcher";
  const logDir = `${os.homedir()}/.cognit/logs`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `	<key>Description</key>`,
    `	<string>${xmlEscape(description)}</string>`,
    `	<key>Label</key>`,
    `	<string>com.cognit.inbox-watch</string>`,
    `	<key>ProgramArguments</key>`,
    `	<array>`,
    `		<string>${xmlEscape(cognit)}</string>`,
    `		<string>inbox</string>`,
    `		<string>--watch</string>`,
    `	</array>`,
    `	<key>WorkingDirectory</key>`,
    `	<string>${xmlEscape(opts.workingDir)}</string>`,
    `	<key>RunAtLoad</key>`,
    `	<true/>`,
    `	<key>KeepAlive</key>`,
    `	<true/>`,
    `	<key>StandardOutPath</key>`,
    `	<string>${xmlEscape(logDir)}/inbox-watch.log</string>`,
    `	<key>StandardErrorPath</key>`,
    `	<string>${xmlEscape(logDir)}/inbox-watch.err.log</string>`,
    `</dict>`,
    `</plist>`,
    "",
  ].join("\n");
}
