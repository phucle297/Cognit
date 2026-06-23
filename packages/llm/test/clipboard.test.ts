/**
 * packages/llm/test/clipboard.test.ts — clipboard abstraction.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §5.
 *
 * Cases:
 *   platform detection (with fs readFileSync mocked to a controllable
 *   osrelease string so tests run identically on Linux + WSL hosts):
 *   1. macOS when process.platform === "darwin" and no WSL signals
 *   2. Linux Wayland when WAYLAND_DISPLAY is set
 *   3. Linux X11 when DISPLAY is set (and no WAYLAND_DISPLAY)
 *   4. Linux unsupported when neither DISPLAY nor WAYLAND_DISPLAY
 *   5. WSL when osrelease contains "microsoft"
 *   6. WSL when WSL_DISTRO_NAME env is set
 *   7. Windows native when process.platform === "win32" and no WSL
 *   8. unsupported when process.platform is unknown (e.g. aix)
 *
 *   readers (execFile + fs/promises.readFile mocked at module level)
 *   9. macOS reader: pbpaste emits PNG bytes → returns image/png
 *  10. macOS reader: pbpaste empty → returns null
 *  11. macOS reader: pbpaste non-PNG → returns null (text on clipboard)
 *  12. X11 reader: xclip emits PNG → returns image/png
 *  13. Wayland reader: wl-paste emits PNG → returns image/png
 *  14. WSL reader: PowerShell returns path, file read → image/png
 *  15. Windows reader: PowerShell returns path, file read → image/png
 *  16. reader throws when subprocess fails (CLI maps to exit 2)
 *
 *  helpers
 *  17. isClipboardSupported matches detectPlatform() !== "unsupported"
 *  18. platformClipboardName returns the human-readable name
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// --- Module-level mocks ------------------------------------------------

// Mock node:fs so the WSL probe (readFileSync on osrelease) is
// controllable. Default: a non-microsoft osrelease so tests run on
// any host (including WSL2 where the real file contains "microsoft").
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn((p: unknown) => {
      if (typeof p === "string" && p === "/proc/sys/kernel/osrelease") {
        return "6.1.0-generic\n";
      }
      // Fall through to the real impl for other paths.
      return actual.readFileSync(p as never);
    }),
  };
});

// Mock node:child_process so execFile is fully controlled.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

// Mock node:fs/promises so readFile for the Windows / WSL clipboard
// paths can return PNG bytes without touching the disk.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
  };
});

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  detectPlatform,
  isClipboardSupported,
  platformClipboardName,
  readClipboardImage,
} from "../src/clipboard.js";

const mockedExecFile = vi.mocked(execFile);
const mockedReadFilePromises = vi.mocked(readFile);
const mockedReadFileSync = vi.mocked(readFileSync);

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

// --- env helpers --------------------------------------------------------

const ORIGINAL_PLATFORM = process.platform;
const ENV_KEYS = ["WAYLAND_DISPLAY", "DISPLAY", "WSL_DISTRO_NAME"] as const;
const SAVED_ENV: Record<string, string | undefined> = {};

const setPlatform = (value: NodeJS.Platform) => {
  Object.defineProperty(process, "platform", { value, configurable: true });
};

const setOsrelease = (text: string) => {
  mockedReadFileSync.mockImplementation((p: unknown) => {
    if (typeof p === "string" && p === "/proc/sys/kernel/osrelease") {
      return text;
    }
    return Buffer.from("");
  });
};

const clearEnv = () => {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
};

const restoreEnv = () => {
  for (const k of ENV_KEYS) {
    const v = SAVED_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

/**
 * promisify(execFile) calls execFile(cmd, args, options, callback).
 * The promisified callback returns (err, result) where result.stdout is
 * either a Buffer or string. This helper builds the right callback
 * invocation from the mocked stdout.
 */
const execFileResolves = (stdout: Buffer | string) => {
  mockedExecFile.mockImplementation(((
    _cmd: unknown,
    _args: unknown,
    _opts: unknown,
    cb: unknown,
  ) => {
    const callback = cb as (err: null, out: { stdout: Buffer | string }) => void;
    callback(null, { stdout });
    return new EventEmitter();
  }) as never);
};

const execFileRejects = (message: string) => {
  mockedExecFile.mockImplementation(((
    _cmd: unknown,
    _args: unknown,
    _opts: unknown,
    cb: unknown,
  ) => {
    const callback = cb as (err: Error, out: unknown) => void;
    callback(new Error(message), null);
    return new EventEmitter();
  }) as never);
};

// --- platform detection ------------------------------------------------

describe("detectPlatform — platform matrix", () => {
  beforeEach(() => {
    clearEnv();
    setOsrelease("6.1.0-generic\n"); // non-microsoft default
  });
  afterEach(() => {
    restoreEnv();
    setPlatform(ORIGINAL_PLATFORM);
  });

  it("1. macOS when process.platform === darwin", () => {
    setPlatform("darwin");
    expect(detectPlatform()).toBe("macos");
  });

  it("2. Linux Wayland when WAYLAND_DISPLAY is set", () => {
    setPlatform("linux");
    process.env.WAYLAND_DISPLAY = "wayland-0";
    expect(detectPlatform()).toBe("linux-wayland");
  });

  it("3. Linux X11 when only DISPLAY is set", () => {
    setPlatform("linux");
    process.env.DISPLAY = ":0";
    expect(detectPlatform()).toBe("linux-x11");
  });

  it("4. Linux unsupported when neither DISPLAY nor WAYLAND_DISPLAY is set", () => {
    setPlatform("linux");
    expect(detectPlatform()).toBe("unsupported");
  });

  it("5. WSL when osrelease contains 'microsoft'", () => {
    setPlatform("linux");
    setOsrelease("5.15.123.1-microsoft-standard-WSL2\n");
    process.env.DISPLAY = ":0"; // ensure WSL beats X11
    expect(detectPlatform()).toBe("wsl");
  });

  it("6. WSL when WSL_DISTRO_NAME env is set", () => {
    setPlatform("linux");
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    process.env.DISPLAY = ":0";
    expect(detectPlatform()).toBe("wsl");
  });

  it("7. Windows native when process.platform === win32 and no WSL", () => {
    setPlatform("win32");
    expect(detectPlatform()).toBe("windows");
  });

  it("8. unsupported when process.platform is unknown", () => {
    setPlatform("aix" as NodeJS.Platform);
    expect(detectPlatform()).toBe("unsupported");
  });
});

// --- platform readers ---------------------------------------------------

describe("readClipboardImage — platform readers (subprocess + fs mocked)", () => {
  beforeEach(() => {
    clearEnv();
    setOsrelease("6.1.0-generic\n");
    mockedExecFile.mockReset();
    mockedReadFilePromises.mockReset();
  });
  afterEach(() => {
    restoreEnv();
    setPlatform(ORIGINAL_PLATFORM);
  });

  it("9. macOS reader: pbpaste PNG bytes → returns image/png", async () => {
    setPlatform("darwin");
    execFileResolves(PNG_BYTES);
    const out = await readClipboardImage();
    expect(out).toEqual({ data: PNG_BYTES, mime: "image/png" });
    expect(mockedExecFile).toHaveBeenCalledWith(
      "pbpaste",
      [],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("10. macOS reader: pbpaste empty → returns null", async () => {
    setPlatform("darwin");
    execFileResolves(Buffer.alloc(0));
    const out = await readClipboardImage();
    expect(out).toBeNull();
  });

  it("11. macOS reader: pbpaste non-PNG (text on clipboard) → returns null", async () => {
    setPlatform("darwin");
    execFileResolves(Buffer.from("hello world", "utf-8"));
    const out = await readClipboardImage();
    expect(out).toBeNull();
  });

  it("12. X11 reader: xclip PNG → returns image/png", async () => {
    setPlatform("linux");
    process.env.DISPLAY = ":0";
    execFileResolves(PNG_BYTES);
    const out = await readClipboardImage();
    expect(out).toEqual({ data: PNG_BYTES, mime: "image/png" });
    expect(mockedExecFile).toHaveBeenCalledWith(
      "xclip",
      ["-selection", "clipboard", "-t", "image/png", "-o"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("13. Wayland reader: wl-paste PNG → returns image/png", async () => {
    setPlatform("linux");
    process.env.WAYLAND_DISPLAY = "wayland-0";
    execFileResolves(PNG_BYTES);
    const out = await readClipboardImage();
    expect(out).toEqual({ data: PNG_BYTES, mime: "image/png" });
    expect(mockedExecFile).toHaveBeenCalledWith(
      "wl-paste",
      ["-t", "image/png"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("14. WSL reader: PowerShell returns path, file read → image/png", async () => {
    setPlatform("linux");
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    execFileResolves("/mnt/c/Users/test/clip.png\n");
    mockedReadFilePromises.mockResolvedValue(PNG_BYTES as never);
    const out = await readClipboardImage();
    expect(out).toEqual({ data: PNG_BYTES, mime: "image/png" });
    expect(mockedReadFilePromises).toHaveBeenCalledWith("/mnt/c/Users/test/clip.png");
  });

  it("15. Windows reader: PowerShell returns path, file read → image/png", async () => {
    setPlatform("win32");
    execFileResolves("C:\\Temp\\clip.png\n");
    mockedReadFilePromises.mockResolvedValue(PNG_BYTES as never);
    const out = await readClipboardImage();
    expect(out).toEqual({ data: PNG_BYTES, mime: "image/png" });
    expect(mockedReadFilePromises).toHaveBeenCalledWith("C:\\Temp\\clip.png");
  });

  it("16. reader throws when subprocess fails (CLI maps to exit 2)", async () => {
    setPlatform("darwin");
    execFileRejects("pbpaste not found");
    await expect(readClipboardImage()).rejects.toThrow(/pbpaste/);
  });
});

// --- helpers ------------------------------------------------------------

describe("isClipboardSupported + platformClipboardName", () => {
  beforeEach(() => {
    clearEnv();
    setOsrelease("6.1.0-generic\n");
  });
  afterEach(() => {
    restoreEnv();
    setPlatform(ORIGINAL_PLATFORM);
  });

  it("17a. isClipboardSupported true when platform is supported", () => {
    setPlatform("darwin");
    expect(isClipboardSupported()).toBe(true);
  });

  it("17b. isClipboardSupported false when platform is unsupported", () => {
    setPlatform("linux");
    expect(isClipboardSupported()).toBe(false);
  });

  it("18. platformClipboardName returns human-readable name per platform", () => {
    setPlatform("darwin");
    expect(platformClipboardName()).toBe("macos");

    setPlatform("linux");
    process.env.DISPLAY = ":0";
    expect(platformClipboardName()).toBe("linux-x11");

    setPlatform("linux");
    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = "wayland-0";
    expect(platformClipboardName()).toBe("linux-wayland");

    setPlatform("win32");
    expect(platformClipboardName()).toBe("windows");

    setPlatform("linux");
    delete process.env.WAYLAND_DISPLAY;
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    process.env.DISPLAY = ":0";
    expect(platformClipboardName()).toBe("wsl");
  });
});