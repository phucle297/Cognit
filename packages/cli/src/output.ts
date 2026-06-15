/**
 * Output mode + stable JSON envelope.
 *
 * Every command in the CLI is either `text` (default — pretty
 * table) or `json` (stable machine-readable envelope). The envelope
 * shape is `{ version: 1, kind: "<command>", data: ... }`. `cognit
 * schema-dump` prints the envelope shape as TypeScript types.
 *
 * Phase 3b ships the mode flag + envelope helper. Coverage of `--json`
 * across every command is incremental: commands that opt in call
 * `getOutputMode()` and route their output through `envelope()`. The
 * `text` path is unchanged. See `phase-3.md` 3b.
 */

export type OutputMode = "text" | "json";

let currentMode: OutputMode = "text";

export function setOutputMode(mode: OutputMode): void {
  currentMode = mode;
}

export function getOutputMode(): OutputMode {
  return currentMode;
}

export interface JsonEnvelopeV1 {
  readonly version: 1;
  readonly kind: string;
  readonly data: unknown;
}

/**
 * Wrap a payload in the stable v1 envelope. `kind` is the dotted
 * command path (`session.show`, `append`, `observation.add`, ...).
 */
export function envelope(kind: string, data: unknown): JsonEnvelopeV1 {
  return { version: 1, kind, data };
}

/**
 * Render to stdout: pretty table for `text`, single-line JSON for
 * `json`. Pretty-prints JSON with 2-space indent so the on-disk log
 * stays readable; `jq` doesn't care.
 */
export function emit(mode: OutputMode, kind: string, data: unknown): void {
  if (mode === "json") {
    process.stdout.write(JSON.stringify(envelope(kind, data), null, 2) + "\n");
    return;
  }
  if (typeof data === "string") {
    process.stdout.write(`${data}\n`);
    return;
  }
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}
