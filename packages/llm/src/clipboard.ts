/**
 * packages/llm/src/clipboard.ts — OS clipboard image read.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §5.
 *
 * Platform matrix:
 *
 * | Platform         | Command                                                  |
 * |------------------|----------------------------------------------------------|
 * | macOS            | `pbpaste` (returns PNG bytes when clipboard has image)   |
 * | Linux X11        | `xclip -selection clipboard -t image/png -o`             |
 * | Linux Wayland    | `wl-paste -t image/png`                                  |
 * | WSL              | PowerShell `Get-Clipboard -Format Image` (base64 decode) |
 * | Windows native   | PowerShell `Get-Clipboard` (file path → read bytes)      |
 * | Other            | returns null from readClipboardImage (unsupported)       |
 *
 * Detection order:
 *   1. WSL (`/proc/sys/kernel/osrelease` contains "microsoft" or
 *      `WSL_DISTRO_NAME` env set) — runs PowerShell on the Windows side
 *   2. macOS (`process.platform === "darwin"`)
 *   3. Windows native (`process.platform === "win32"`)
 *   4. Linux: Wayland when `WAYLAND_DISPLAY` set, else X11
 *   5. Fallback: unsupported
 *
 * Returned MIME: `image/png` when pbpaste / xclip / wl-paste emit PNG
 * (always PNG per spec §5 table). WSL / Windows may need MIME sniff
 * via `sniffMime` upstream — we always return PNG here and let the
 * caller fall through if needed.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

/** Identifies the platform we routed to. Exposed for error messages. */
export type Platform = "macos" | "linux-x11" | "linux-wayland" | "wsl" | "windows" | "unsupported";

/**
 * Resolve the current platform for clipboard routing. Pure (no I/O).
 * The WSL probe reads `/proc/sys/kernel/osrelease` — present on Linux
 * only, so this is a sync file read; safe to call repeatedly.
 */
export const detectPlatform = (): Platform => {
  if (isWSL()) return "wsl";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") {
    if (process.env.WAYLAND_DISPLAY) return "linux-wayland";
    if (process.env.DISPLAY) return "linux-x11";
    return "unsupported";
  }
  return "unsupported";
};

/** True when the current platform has a clipboard image-read path. */
export const isClipboardSupported = (): boolean => detectPlatform() !== "unsupported";

/** Human-readable platform name. Used in error messages. */
export const platformClipboardName = (): string => {
  const p = detectPlatform();
  switch (p) {
    case "macos":
      return "macos";
    case "linux-x11":
      return "linux-x11";
    case "linux-wayland":
      return "linux-wayland";
    case "wsl":
      return "wsl";
    case "windows":
      return "windows";
    case "unsupported":
      return "unsupported";
  }
};

/**
 * Read an image from the OS clipboard. Returns `null` when the platform
 * has no clipboard read path; throws when the subprocess fails (so the
 * CLI can exit with code 2 per spec §3 exit table).
 *
 * The returned MIME is always `image/png` for the macOS / X11 / Wayland
 * paths (their commands emit PNG when the clipboard holds an image).
 * WSL / Windows paths also surface PNG because PowerShell returns the
 * image as a base64 string or a file path that points at a PNG.
 */
export const readClipboardImage = async (): Promise<{ data: Buffer; mime: string } | null> => {
  const platform = detectPlatform();
  switch (platform) {
    case "macos":
      return readMacOS();
    case "linux-x11":
      return readX11();
    case "linux-wayland":
      return readWayland();
    case "wsl":
      return readWSL();
    case "windows":
      return readWindowsNative();
    case "unsupported":
      return null;
  }
};

// --- platform probes ----------------------------------------------------

/**
 * WSL probe: read `/proc/sys/kernel/osrelease` and check for the
 * "microsoft" substring, OR honour the `WSL_DISTRO_NAME` env that
 * Microsoft sets inside WSL sessions. Both signals are stable across
 * WSL1 and WSL2.
 *
 * Uses a top-level `readFileSync` import (not inline `require`) so
 * vitest's `vi.mock("node:fs")` intercepts it. Inline `require`
 * bypasses the module mock layer in ESM-mode vitest.
 */
const isWSL = (): boolean => {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    const release = readFileSync("/proc/sys/kernel/osrelease", "utf-8");
    return /microsoft/i.test(release);
  } catch {
    return false;
  }
};

// --- platform readers ---------------------------------------------------

const readMacOS = async (): Promise<{ data: Buffer; mime: string } | null> => {
  // `pbpaste` emits PNG bytes when the clipboard holds an image;
  // emits text otherwise. We treat empty / text-decoding output as
  // "no image" (return null). The MIME is always PNG when present.
  const { stdout } = await execFileAsync("pbpaste", [], {
    maxBuffer: 100 * 1024 * 1024, // 100 MB cap; large clipboard images
    encoding: "buffer",
  });
  const buf = stdout as Buffer;
  if (buf.length === 0) return null;
  // PNG magic 89 50 4E 47
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { data: buf, mime: "image/png" };
  }
  return null;
};

const readX11 = async (): Promise<{ data: Buffer; mime: string } | null> => {
  const { stdout } = await execFileAsync(
    "xclip",
    ["-selection", "clipboard", "-t", "image/png", "-o"],
    { maxBuffer: 100 * 1024 * 1024, encoding: "buffer" },
  );
  const buf = stdout as Buffer;
  if (buf.length === 0) return null;
  return { data: buf, mime: "image/png" };
};

const readWayland = async (): Promise<{ data: Buffer; mime: string } | null> => {
  const { stdout } = await execFileAsync("wl-paste", ["-t", "image/png"], {
    maxBuffer: 100 * 1024 * 1024,
    encoding: "buffer",
  });
  const buf = stdout as Buffer;
  if (buf.length === 0) return null;
  return { data: buf, mime: "image/png" };
};

const readWSL = async (): Promise<{ data: Buffer; mime: string } | null> => {
  // PowerShell `Get-Clipboard -Format Image` returns the file path of
  // a temp PNG written by Windows. We parse the path, then read the
  // bytes from WSL's view of the Windows filesystem (/mnt/c/...).
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Format Image"],
    { maxBuffer: 1024 * 1024, encoding: "utf-8" },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // PowerShell returns the path verbatim. Strip surrounding quotes.
  const path = trimmed.replace(/^["']|["']$/g, "");
  const data = await readFile(path);
  if (data.length === 0) return null;
  return { data, mime: "image/png" };
};

const readWindowsNative = async (): Promise<{ data: Buffer; mime: string } | null> => {
  // On native Windows we route through PowerShell. `Get-Clipboard`
  // without `-Format Image` returns text; with it, returns the temp
  // PNG path. We request Image then read the bytes back.
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Format Image"],
    { maxBuffer: 1024 * 1024, encoding: "utf-8" },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const path = trimmed.replace(/^["']|["']$/g, "");
  const data = await readFile(path);
  if (data.length === 0) return null;
  return { data, mime: "image/png" };
};

// Internal exports for tests (not part of the public surface; the
// re-export from index.ts omits these).
export const __test__ = { isWSL, readMacOS, readX11, readWayland, readWSL, readWindowsNative };