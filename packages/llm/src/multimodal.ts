/**
 * packages/llm/src/multimodal.ts — input resolution + MIME sniff.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §5.
 *
 * Pure module, no CLI deps. The CLI command (`cognit ask`) orchestrates
 * these primitives; this module never touches process.argv, the env, or
 * process.exit. The clipboard adapter (`./clipboard.js`) is the only
 * platform-aware import — its API is mocked in tests.
 *
 * Public surface:
 *   - `InputSource` / `Attachment` — typed input + output shapes
 *   - `resolveInput(source, stdinBytes?)` — fetch bytes + classify
 *   - `autoDetectInput({explicit?, stdinIsPiped, stdinFirstBytes})`
 *   - `classifyStdin(bytes)` — "text" | "binary" | "unknown"
 *   - `sniffMime(bytes, ext?)` — MIME from ext then magic-number table
 *   - `MultimodalError` — typed error with platform-agnostic messages
 *
 * Magic-number table (spec §5, fixed):
 *
 * | Bytes                                | MIME                |
 * |--------------------------------------|---------------------|
 * | 89 50 4E 47 0D 0A 1A 0A              | image/png           |
 * | FF D8 FF                             | image/jpeg          |
 * | 47 49 46 38                          | image/gif           |
 * | 52 49 46 46 ?? ?? ?? ?? 57 45 42 50  | image/webp          |
 * | 25 50 44 46                          | application/pdf     |
 * | 50 4B 03 04                          | application/zip     |
 *
 * Resolution order (spec §3):
 *   1. `--input <source>` flag → exact source
 *   2. no --input + stdin piped → stdin
 *   3. no --input + stdin TTY → caller decides (clipboard vs text-only)
 *   4. else → text-only prompt
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  readClipboardImage,
  isClipboardSupported,
  platformClipboardName,
} from "./clipboard.js";

// --- Public types ------------------------------------------------------

/** Discriminated union describing where input bytes come from. */
export type InputSource =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string }
  | { kind: "stdin" }
  | { kind: "clipboard" };

/**
 * Resolved attachment ready to send to the model. `image` is for
 * multimodal content parts; `file` is for document attachments with a
 * filename.
 */
export type Attachment =
  | { type: "image"; data: Buffer; mime: string }
  | { type: "file"; data: Buffer; mime: string; filename: string };

/**
 * Typed error for all multimodal failures. Callers map this to the
 * CLI exit-code table (spec §3): unknown MIME / missing file /
 * unsupported clipboard all exit 2.
 */
export class MultimodalError extends Error {
  override readonly name = "MultimodalError" as const;
  constructor(message: string) {
    super(message);
  }
}

// --- Magic-number table ------------------------------------------------

interface Signature {
  readonly mime: string;
  /** Prefix that must match exactly. */
  readonly prefix: Uint8Array;
  /**
   * Optional suffix to match AFTER `prefix.length + suffixOffset` bytes.
   * Used for WebP (RIFF????WEBP) where the 4 size bytes are variable.
   */
  readonly suffix?: { offset: number; bytes: Uint8Array };
}

const SIGNATURES: ReadonlyArray<Signature> = [
  {
    mime: "image/png",
    prefix: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mime: "image/jpeg", prefix: new Uint8Array([0xff, 0xd8, 0xff]) },
  { mime: "image/gif", prefix: new Uint8Array([0x47, 0x49, 0x46, 0x38]) },
  {
    mime: "image/webp",
    prefix: new Uint8Array([0x52, 0x49, 0x46, 0x46]), // "RIFF"
    suffix: { offset: 4, bytes: new Uint8Array([0x57, 0x45, 0x42, 0x50]) }, // "WEBP" after 4 size bytes
  },
  {
    mime: "application/pdf",
    prefix: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // "%PDF"
  },
  {
    mime: "application/zip",
    prefix: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  },
];

/** Extension → MIME table. Keys are lowercase, leading dot. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

// --- MIME sniffing -----------------------------------------------------

/**
 * Detect MIME from the file extension first (when known), then from
 * the magic-number table. Returns null when neither yields a match.
 *
 * Spec §3: "MIME auto-detection (file path): from extension first,
 * then magic-number sniff if extension unknown."
 */
export const sniffMime = (firstBytes: Buffer, ext?: string): string | null => {
  if (ext) {
    const fromExt = MIME_BY_EXT[ext.toLowerCase()];
    if (fromExt !== undefined) return fromExt;
  }
  for (const sig of SIGNATURES) {
    if (matchesSignature(firstBytes, sig)) return sig.mime;
  }
  return null;
};

const matchesSignature = (bytes: Buffer, sig: Signature): boolean => {
  if (bytes.length < sig.prefix.length) return false;
  for (let i = 0; i < sig.prefix.length; i++) {
    if (bytes[i] !== sig.prefix[i]) return false;
  }
  if (sig.suffix) {
    const start = sig.prefix.length + sig.suffix.offset;
    if (bytes.length < start + sig.suffix.bytes.length) return false;
    for (let i = 0; i < sig.suffix.bytes.length; i++) {
      if (bytes[start + i] !== sig.suffix.bytes[i]) return false;
    }
  }
  return true;
};

// --- Stdin classification ----------------------------------------------

/**
 * Classify stdin bytes per spec §3:
 *   - any known magic → "binary"
 *   - NUL byte present → "binary"
 *   - valid UTF-8 without NUL → "text"
 *   - invalid UTF-8 without NUL → "unknown"
 *   - empty → "unknown"
 *
 * The CLI command turns "unknown" into a clean error: `stdin: cannot
 * determine text vs binary (first bytes: <hex>)`.
 */
export const classifyStdin = (firstBytes: Buffer): "text" | "binary" | "unknown" => {
  if (firstBytes.length === 0) return "unknown";
  for (const sig of SIGNATURES) {
    if (matchesSignature(firstBytes, sig)) return "binary";
  }
  for (let i = 0; i < firstBytes.length; i++) {
    if (firstBytes[i] === 0) return "binary";
  }
  // Buffer.toString("utf-8") replaces invalid sequences with U+FFFD.
  // If we see any replacement char, the input is not valid UTF-8.
  const decoded = firstBytes.toString("utf-8");
  if (decoded.includes("�")) return "unknown";
  return "text";
};

// --- Input source detection -------------------------------------------

/**
 * Resolve which input source to use given the CLI flags + stdin state.
 *
 * Returns `null` when the CLI must decide between clipboard (TTY +
 * clipboard has image) and text-only. This module never reads the
 * clipboard directly — the CLI wires it.
 */
export const autoDetectInput = async (args: {
  explicit?: string;
  stdinIsPiped: boolean;
  stdinFirstBytes: Buffer;
}): Promise<InputSource | null> => {
  if (args.explicit !== undefined) {
    const v = args.explicit.trim();
    if (v === "-") return { kind: "stdin" };
    if (v === "clipboard") return { kind: "clipboard" };
    if (/^https?:\/\//i.test(v)) return { kind: "url", url: v };
    return { kind: "file", path: v };
  }
  if (args.stdinIsPiped) return { kind: "stdin" };
  return null;
};

// --- Resolve bytes + classify -----------------------------------------

/**
 * Fetch bytes for a source and classify into an `Attachment`.
 *
 * For `stdin`, the caller MUST pass `stdinBytes` (the module does not
 * read `process.stdin` — that would couple the LLM package to the
 * CLI's stdin loop and break unit tests).
 */
export const resolveInput = async (
  source: InputSource,
  stdinBytes?: Buffer,
): Promise<Attachment> => {
  switch (source.kind) {
    case "file":
      return resolveFile(source.path);
    case "url":
      return resolveUrl(source.url);
    case "stdin":
      return resolveStdinBytes(stdinBytes);
    case "clipboard":
      return resolveClipboard();
  }
};

const resolveFile = async (path: string): Promise<Attachment> => {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new MultimodalError(`file: cannot read ${path}: ${reason}`);
  }
  const ext = extname(path);
  const mime = sniffMime(data, ext);
  if (mime === null) {
    throw new MultimodalError(
      `file: unknown MIME for ${path} (first bytes: ${data.subarray(0, 16).toString("hex")})`,
    );
  }
  if (mime.startsWith("image/")) {
    return { type: "image", data, mime };
  }
  const filename = path.split(/[\\/]/).pop() || "attachment";
  return { type: "file", data, mime, filename };
};

const resolveUrl = async (url: string): Promise<Attachment> => {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new MultimodalError(`url: fetch failed for ${url}: ${reason}`);
  }
  if (!res.ok) {
    throw new MultimodalError(`url: fetch returned HTTP ${res.status} for ${url}`);
  }
  const ab = await res.arrayBuffer();
  const data = Buffer.from(ab);
  const mime = sniffMime(data);
  if (mime === null) {
    throw new MultimodalError(
      `url: unknown MIME for ${url} (first bytes: ${data.subarray(0, 16).toString("hex")})`,
    );
  }
  if (mime.startsWith("image/")) {
    return { type: "image", data, mime };
  }
  // Derive filename from URL path; fall back to "download".
  let filename = "download";
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").pop();
    if (last) filename = last;
  } catch {
    /* keep default */
  }
  return { type: "file", data, mime, filename };
};

const resolveStdinBytes = async (stdinBytes: Buffer | undefined): Promise<Attachment> => {
  if (stdinBytes === undefined) {
    throw new MultimodalError("stdin: bytes not provided to resolveInput");
  }
  const cls = classifyStdin(stdinBytes);
  if (cls === "unknown") {
    throw new MultimodalError(
      `stdin: cannot determine text vs binary (first bytes: ${stdinBytes.subarray(0, 16).toString("hex")})`,
    );
  }
  if (cls === "text") {
    return {
      type: "file",
      data: stdinBytes,
      mime: "text/plain",
      filename: "stdin.txt",
    };
  }
  // binary: sniff magic to get exact MIME
  const mime = sniffMime(stdinBytes);
  if (mime === null) {
    throw new MultimodalError(
      `stdin: binary content with unknown magic (first bytes: ${stdinBytes.subarray(0, 16).toString("hex")})`,
    );
  }
  if (mime.startsWith("image/")) {
    return { type: "image", data: stdinBytes, mime };
  }
  return { type: "file", data: stdinBytes, mime, filename: "stdin.bin" };
};

const resolveClipboard = async (): Promise<Attachment> => {
  if (!isClipboardSupported()) {
    throw new MultimodalError(
      `clipboard image read not supported on this platform (${platformClipboardName()})`,
    );
  }
  const got = await readClipboardImage();
  if (got === null) {
    throw new MultimodalError(
      "clipboard: no image on clipboard (or read returned empty)",
    );
  }
  return { type: "image", data: got.data, mime: got.mime };
};

// Suppress unused-import warning when buffer allocation helpers change.
export const __test__ = { matchesSignature, SIGNATURES };