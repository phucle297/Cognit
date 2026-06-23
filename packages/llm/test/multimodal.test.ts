/**
 * packages/llm/test/multimodal.test.ts — input resolution + MIME sniff.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §5.
 *
 * Cases:
 *  sniffMime (magic-number table):
 *   1. PNG magic → "image/png"
 *   2. JPEG magic → "image/jpeg"
 *   3. GIF magic (GIF87a / GIF89a both) → "image/gif"
 *   4. WebP magic (RIFF....WEBP) → "image/webp"
 *   5. RIFF + 4 size bytes + non-WEBP suffix → null
 *   6. PDF magic → "application/pdf"
 *   7. ZIP magic → "application/zip"
 *   8. unknown bytes → null
 *   9. ext takes precedence over magic when ext is known
 *  10. unknown ext falls through to magic sniff
 *  11. .txt ext → "text/plain" (no magic match needed)
 *
 *  classifyStdin (text vs binary heuristic):
 *  12. PNG magic → "binary"
 *  13. valid UTF-8 text without NUL → "text"
 *  14. bytes containing NUL → "binary" (even without magic match)
 *  15. invalid UTF-8 without NUL → "unknown"
 *  16. empty buffer → "unknown"
 *
 *  autoDetectInput (source resolution):
 *  17. explicit "/path/to/file" → { kind: "file", path }
 *  18. explicit "https://example.com/x.png" → { kind: "url", url }
 *  19. explicit "-" → { kind: "stdin" }
 *  20. explicit "clipboard" → { kind: "clipboard" }
 *  21. no explicit + stdinIsPiped=true → { kind: "stdin" }
 *  22. no explicit + stdinIsPiped=false → null (caller picks clipboard/text)
 *
 *  resolveInput (data fetch + classification):
 *  23. file source: reads bytes, sniffs MIME, returns image attachment
 *  24. file source with .txt ext: returns file attachment with text/plain
 *  25. file source with unknown MIME: throws MultimodalError
 *  26. file source: throws when path does not exist
 *  27. url source: fetches bytes via global fetch (mocked), sniffs MIME
 *  28. url source: throws when fetch returns non-ok status
 *  29. url source: throws when fetch network error
 *  30. stdin source with bytes: classifies + sniffs, returns attachment
 *  31. stdin source without bytes: throws MultimodalError
 *  32. stdin source: text bytes return file attachment with text/plain
 *  33. clipboard source: delegates to readClipboardImage, returns image
 *  34. clipboard source on unsupported platform: throws with platform name
 *
 *  public surface:
 *  35. multimodal.ts exports the documented public surface
 *  35b. clipboard.ts exports the documented public surface
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyStdin,
  autoDetectInput,
  resolveInput,
  sniffMime,
  MultimodalError,
  type InputSource,
} from "../src/multimodal.js";

// Mock the clipboard module so resolveInput({kind:"clipboard"}) is
// deterministic across platforms. The mock is applied per-test where
// needed; default returns null (unsupported).
vi.mock("../src/clipboard.js", () => ({
  readClipboardImage: vi.fn(),
  isClipboardSupported: vi.fn(),
  platformClipboardName: vi.fn(),
}));

import {
  readClipboardImage,
  isClipboardSupported,
  platformClipboardName,
} from "../src/clipboard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(__dirname, "fixtures");

// --- magic byte fixtures ------------------------------------------------

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF87A_BYTES = Buffer.from("GIF87a......", "ascii");
const GIF89A_BYTES = Buffer.from("GIF89a......", "ascii");
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]), // size (don't care)
  Buffer.from("WEBP"),
  Buffer.from("VP8L......"),
]);
const NON_WEBP_RIFF = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WAVE"),
]);
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
const UNKNOWN_BYTES = Buffer.from("this is not a known format", "utf-8");
const TEXT_BYTES = Buffer.from("hello, world\nthis is plain text\n", "utf-8");
const NUL_BYTES = Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]); // "he\0lo"
const INVALID_UTF8 = Buffer.from([0xc3, 0x28, 0xa0, 0xa1]); // invalid 2-byte seq, no NUL

describe("sniffMime — magic-number table (spec §5)", () => {
  it("1. PNG magic → image/png", () => {
    expect(sniffMime(PNG_BYTES)).toBe("image/png");
  });

  it("2. JPEG magic → image/jpeg", () => {
    expect(sniffMime(JPEG_BYTES)).toBe("image/jpeg");
  });

  it("3. GIF87a + GIF89a magic → image/gif", () => {
    expect(sniffMime(GIF87A_BYTES)).toBe("image/gif");
    expect(sniffMime(GIF89A_BYTES)).toBe("image/gif");
  });

  it("4. RIFF + size + WEBP → image/webp", () => {
    expect(sniffMime(WEBP_BYTES)).toBe("image/webp");
  });

  it("5. RIFF + size + non-WEBP suffix → null", () => {
    expect(sniffMime(NON_WEBP_RIFF)).toBeNull();
  });

  it("6. PDF magic → application/pdf", () => {
    expect(sniffMime(PDF_BYTES)).toBe("application/pdf");
  });

  it("7. ZIP magic → application/zip", () => {
    expect(sniffMime(ZIP_BYTES)).toBe("application/zip");
  });

  it("8. unknown bytes → null", () => {
    expect(sniffMime(UNKNOWN_BYTES)).toBeNull();
  });

  it("9. known ext takes precedence over magic", () => {
    // Bytes look like plain text but ext says .png
    expect(sniffMime(TEXT_BYTES, ".png")).toBe("image/png");
  });

  it("10. unknown ext falls through to magic sniff", () => {
    expect(sniffMime(PNG_BYTES, ".weird")).toBe("image/png");
  });

  it("11. .txt ext → text/plain even without magic match", () => {
    expect(sniffMime(TEXT_BYTES, ".txt")).toBe("text/plain");
  });
});

describe("classifyStdin — text vs binary heuristic", () => {
  it("12. PNG magic → binary", () => {
    expect(classifyStdin(PNG_BYTES)).toBe("binary");
  });

  it("13. valid UTF-8 text without NUL → text", () => {
    expect(classifyStdin(TEXT_BYTES)).toBe("text");
  });

  it("14. bytes containing NUL → binary", () => {
    expect(classifyStdin(NUL_BYTES)).toBe("binary");
  });

  it("15. invalid UTF-8 without NUL → unknown", () => {
    expect(classifyStdin(INVALID_UTF8)).toBe("unknown");
  });

  it("16. empty buffer → unknown", () => {
    expect(classifyStdin(Buffer.alloc(0))).toBe("unknown");
  });
});

describe("autoDetectInput — source resolution", () => {
  it("17. explicit path → file source", async () => {
    const out = await autoDetectInput({
      explicit: "/tmp/img.png",
      stdinIsPiped: false,
      stdinFirstBytes: Buffer.alloc(0),
    });
    expect(out).toEqual({ kind: "file", path: "/tmp/img.png" });
  });

  it("18. explicit http URL → url source", async () => {
    const out = await autoDetectInput({
      explicit: "https://example.com/x.png",
      stdinIsPiped: false,
      stdinFirstBytes: Buffer.alloc(0),
    });
    expect(out).toEqual({ kind: "url", url: "https://example.com/x.png" });
  });

  it("19. explicit '-' → stdin source", async () => {
    const out = await autoDetectInput({
      explicit: "-",
      stdinIsPiped: true,
      stdinFirstBytes: PNG_BYTES,
    });
    expect(out).toEqual({ kind: "stdin" });
  });

  it("20. explicit 'clipboard' → clipboard source", async () => {
    const out = await autoDetectInput({
      explicit: "clipboard",
      stdinIsPiped: false,
      stdinFirstBytes: Buffer.alloc(0),
    });
    expect(out).toEqual({ kind: "clipboard" });
  });

  it("21. no explicit + stdinIsPiped → stdin source", async () => {
    const out = await autoDetectInput({
      stdinIsPiped: true,
      stdinFirstBytes: PNG_BYTES,
    });
    expect(out).toEqual({ kind: "stdin" });
  });

  it("22. no explicit + stdin not piped → null (caller decides)", async () => {
    const out = await autoDetectInput({
      stdinIsPiped: false,
      stdinFirstBytes: Buffer.alloc(0),
    });
    expect(out).toBeNull();
  });
});

describe("resolveInput — data fetch + classification", () => {
  beforeEach(() => {
    vi.mocked(readClipboardImage).mockReset();
    vi.mocked(isClipboardSupported).mockReset();
    vi.mocked(platformClipboardName).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("23. file source: reads bytes, sniffs MIME, returns image attachment", async () => {
    const src: InputSource = { kind: "file", path: path.join(FIXTURE_DIR, "pixel.png") };
    const out = await resolveInput(src);
    expect(out.type).toBe("image");
    if (out.type === "image") {
      expect(out.mime).toBe("image/png");
      expect(out.data.length).toBeGreaterThan(0);
    }
  });

  it("24. file source with .txt ext → file attachment text/plain", async () => {
    const src: InputSource = { kind: "file", path: path.join(FIXTURE_DIR, "note.txt") };
    const out = await resolveInput(src);
    expect(out.type).toBe("file");
    if (out.type === "file") {
      expect(out.mime).toBe("text/plain");
      expect(out.data.toString("utf-8")).toContain("hello");
    }
  });

  it("25. file source: throws MultimodalError when MIME unknown", async () => {
    const src: InputSource = { kind: "file", path: path.join(FIXTURE_DIR, "blob.bin") };
    await expect(resolveInput(src)).rejects.toBeInstanceOf(MultimodalError);
  });

  it("26. file source: throws when path does not exist", async () => {
    const src: InputSource = { kind: "file", path: "/tmp/cognit-no-such-file-xyz.png" };
    await expect(resolveInput(src)).rejects.toBeInstanceOf(MultimodalError);
  });

  it("27. url source: fetches bytes via global fetch (mocked), sniffs MIME", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => PNG_BYTES,
    });
    vi.stubGlobal("fetch", fetchMock);
    const src: InputSource = { kind: "url", url: "https://example.com/img.png" };
    const out = await resolveInput(src);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/img.png");
    expect(out.type).toBe("image");
    if (out.type === "image") {
      expect(out.mime).toBe("image/png");
    }
  });

  it("28. url source: throws when fetch returns non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
    );
    const src: InputSource = { kind: "url", url: "https://example.com/missing.png" };
    await expect(resolveInput(src)).rejects.toBeInstanceOf(MultimodalError);
  });

  it("29. url source: throws when fetch network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const src: InputSource = { kind: "url", url: "https://example.com/x.png" };
    await expect(resolveInput(src)).rejects.toBeInstanceOf(MultimodalError);
  });

  it("30. stdin source with binary bytes → image attachment", async () => {
    const src: InputSource = { kind: "stdin" };
    const out = await resolveInput(src, PNG_BYTES);
    expect(out.type).toBe("image");
    if (out.type === "image") expect(out.mime).toBe("image/png");
  });

  it("31. stdin source without bytes → throws MultimodalError", async () => {
    const src: InputSource = { kind: "stdin" };
    await expect(resolveInput(src)).rejects.toBeInstanceOf(MultimodalError);
  });

  it("32. stdin source with text bytes → file attachment text/plain", async () => {
    const src: InputSource = { kind: "stdin" };
    const out = await resolveInput(src, TEXT_BYTES);
    expect(out.type).toBe("file");
    if (out.type === "file") {
      expect(out.mime).toBe("text/plain");
      expect(out.data.toString("utf-8")).toContain("hello");
    }
  });

  it("33. clipboard source: delegates to readClipboardImage, returns image", async () => {
    vi.mocked(isClipboardSupported).mockReturnValue(true);
    vi.mocked(platformClipboardName).mockReturnValue("macos");
    vi.mocked(readClipboardImage).mockResolvedValue({
      data: PNG_BYTES,
      mime: "image/png",
    });
    const src: InputSource = { kind: "clipboard" };
    const out = await resolveInput(src);
    expect(out.type).toBe("image");
    if (out.type === "image") {
      expect(out.mime).toBe("image/png");
      expect(out.data.length).toBe(PNG_BYTES.length);
    }
  });

  it("34. clipboard source on unsupported platform → throws with platform name", async () => {
    vi.mocked(isClipboardSupported).mockReturnValue(false);
    vi.mocked(platformClipboardName).mockReturnValue("plan9");
    const src: InputSource = { kind: "clipboard" };
    await expect(resolveInput(src)).rejects.toBeInstanceOf(MultimodalError);
    await expect(resolveInput(src)).rejects.toThrow(/plan9/);
  });
});

describe("multimodal — public surface", () => {
  it("35. multimodal.ts exports the documented public surface", async () => {
    const mod = await import("../src/multimodal.js");
    expect(typeof mod.classifyStdin).toBe("function");
    expect(typeof mod.autoDetectInput).toBe("function");
    expect(typeof mod.resolveInput).toBe("function");
    expect(typeof mod.sniffMime).toBe("function");
    expect(typeof mod.MultimodalError).toBe("function");
  });

  it("35b. multimodal imports only the three clipboard adapter functions", () => {
    // Verifies the surface multimodal.ts depends on. detectPlatform +
    // Platform type live in clipboard.ts but are NOT imported here —
    // the multimodal module only needs the three reader predicates.
    const source = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../src/multimodal.ts"),
      "utf-8",
    ) as string;
    expect(source).toMatch(/from "\.\/clipboard\.js"/);
    expect(source).toMatch(/readClipboardImage/);
    expect(source).toMatch(/isClipboardSupported/);
    expect(source).toMatch(/platformClipboardName/);
    expect(source).not.toMatch(/detectPlatform/);
  });
});

// Suppress unused import warning for readFile when no fixture exists
void readFile;