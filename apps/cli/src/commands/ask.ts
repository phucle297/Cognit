/**
 * apps/cli/src/commands/ask.ts — `cognit ask` one-shot LLM query.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §3.
 *
 * Surface:
 *   cognit ask [options] [--prompt <text>]
 *
 *   -p, --prompt <text>      user prompt. Required only if no text source
 *                              is available (stdin text, --input text file)
 *   -m, --model <id>         model override (else from llm.commands.ask.model
 *                              → llm.default_model)
 *   --input <source>         explicit source: <path> | <url> | - | clipboard
 *   --max-output-tokens <n>  cap output length (forwarded to generateText)
 *   --temperature <float>    sampling temperature (forwarded to generateText)
 *   -j, --json               emit stable JSON envelope on stdout
 *
 * Input resolution order (spec §3):
 *   1. --input <source>
 *   2. stdin piped → stdin bytes
 *   3. TTY + clipboard has image → clipboard image
 *   4. Else → text-only prompt (no multimodal)
 *
 * Stdin classification (via @cognit/llm multimodal):
 *   - magic match → image/file attachment
 *   - valid UTF-8 without NUL → text, appended to --prompt with \n\n
 *   - NUL byte → binary (treat as file)
 *   - invalid UTF-8 → error
 *
 * Exit codes (spec §3):
 *   2  missing model / missing env / file not found / unknown MIME /
 *      clipboard unsupported / stdin ambiguous
 *   1  network or HTTP error from Gateway
 *   3  model not in Gateway catalog (catchable from generateText)
 *   130  SIGINT
 *
 * Structured output:
 *   - default (text): model response text on stdout
 *   - --json: stable v1 envelope `{ version: 1, kind: "ask", data: {
 *       schema_version: "1", model, prompt_tokens, completion_tokens,
 *       text, attachments } }`
 *
 * The command is structured as:
 *   - `runAsk(opts, deps)` — pure entry point, deps-injectable for tests
 *   - `registerAsk(program)` — wires real deps and calls runAsk
 */
import { Command } from "commander";
import { generateText } from "ai";
import type {
  InputSource,
  Attachment,
} from "@cognit/llm";
import {
  autoDetectInput,
  classifyStdin,
  resolveInput,
  isClipboardSupported,
  gatewayModel,
} from "@cognit/llm";
import type { CognitConfig } from "@cognit/core/config";
import { readConfig } from "../yaml-io.js";
import { findProjectRoot, projectPaths } from "../paths.js";
import { resolveApiKey, resolveModel } from "../config-resolver.js";
import { envelope, getOutputMode } from "../output.js";

/** CLI options parsed by commander. Strings are kept raw — they are
 *  parsed in runAsk so the same path runs from tests. */
export interface AskOptions {
  prompt?: string;
  model?: string;
  input?: string;
  maxOutputTokens?: string;
  temperature?: string;
}

/** The minimum multimodal surface the command consumes. Re-declared
 *  here (rather than imported from `@cognit/llm`) so test mocks can
 *  replace individual functions without taking down the whole barrel. */
export interface AskMultimodalDeps {
  readonly autoDetectInput: typeof autoDetectInput;
  readonly resolveInput: typeof resolveInput;
  readonly classifyStdin: typeof classifyStdin;
  readonly isClipboardSupported: typeof isClipboardSupported;
}

/** All injectable dependencies for `runAsk`. Tests substitute each
 *  field; the CLI wiring passes the real implementations. */
export interface AskDeps {
  readonly readConfig: typeof readConfig;
  readonly findProjectRoot: typeof findProjectRoot;
  readonly projectPaths: typeof projectPaths;
  readonly readStdin: () => Promise<{ bytes: Buffer; piped: boolean }>;
  readonly gatewayModel: typeof gatewayModel;
  readonly generateText: typeof generateText;
  readonly multimodal: AskMultimodalDeps;
  /** Override `console.log`-style writers so tests can capture output
   *  without touching real stdout/stderr. */
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Override the exit-code setter so tests can read the value
   *  instead of killing the process. */
  readonly setExitCode: (code: number) => void;
  /** Override env reads so tests can clear / set keys without
   *  mutating `process.env` globally. */
  readonly getEnv: (name: string) => string | undefined;
  /** Override the SIGINT listener registration so tests don't fight
   *  with vitest's signal handling. */
  readonly installSigintHandler: (handler: () => void) => () => void;
}

/** Subset of `Attachment` after we coerce it into a content part. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: Buffer; mediaType?: string }
  | { type: "file"; data: Buffer; mediaType: string; filename?: string };

/** Wire shape for the JSON envelope `data` payload (spec §3 Output). */
interface AskEnvelopeData {
  readonly schema_version: "1";
  readonly model: string;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly text: string;
  readonly attachments: ReadonlyArray<AskAttachment>;
}

/** Per-attachment shape inside the JSON envelope. Image entries
 *  carry mime + size_bytes; file entries additionally carry filename. */
type AskAttachment =
  | { type: "image"; mime: string; size_bytes: number }
  | { type: "file"; mime: string; filename: string; size_bytes: number };

/** Default deps — the production wiring. Tests construct their own. */
const defaultDeps = (): AskDeps => ({
  readConfig,
  findProjectRoot,
  projectPaths,
  readStdin: realReadStdin,
  gatewayModel,
  generateText,
  multimodal: {
    autoDetectInput,
    resolveInput,
    classifyStdin,
    isClipboardSupported,
  },
  stdout: (line) => process.stdout.write(line),
  stderr: (line) => process.stderr.write(line),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  getEnv: (name) => process.env[name],
  installSigintHandler: (handler) => {
    const wrapped = (): void => handler();
    process.on("SIGINT", wrapped);
    return () => process.removeListener("SIGINT", wrapped);
  },
});

/** Read all of stdin into a single Buffer (or return empty if TTY). */
const realReadStdin = async (): Promise<{ bytes: Buffer; piped: boolean }> => {
  if (process.stdin.isTTY) {
    return { bytes: Buffer.alloc(0), piped: false };
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return { bytes: Buffer.concat(chunks), piped: true };
};

/**
 * Convert a resolved `Attachment` into a Vercel AI SDK content part.
 * Image → `{type:"image", image, mediaType}`. File → `{type:"file",
 * data, mediaType, filename}`. Pure mapping, no I/O.
 */
const attachmentToContentPart = (a: Attachment): ContentPart => {
  if (a.type === "image") {
    return {
      type: "image",
      image: a.data,
      mediaType: a.mime,
    };
  }
  return {
    type: "file",
    data: a.data,
    mediaType: a.mime,
    filename: a.filename,
  };
};

/** Build the JSON-envelope `attachments` list from a resolved
 *  attachment (or null for text-only). Matches the spec §3 Output
 *  shape: `{type, mime, size_bytes, ...}`. */
const envelopeAttachments = (a: Attachment | null): ReadonlyArray<AskAttachment> => {
  if (a === null) return [];
  if (a.type === "image") {
    return [{ type: "image", mime: a.mime, size_bytes: a.data.length }];
  }
  return [
    {
      type: "file",
      mime: a.mime,
      filename: a.filename,
      size_bytes: a.data.length,
    },
  ];
};

/** Pretty-print the typed error class name + message. Used for
 *  stderr lines in both text and json modes. */
const errorLabel = (e: unknown): string => {
  if (e instanceof Error) {
    const name = e.name !== "Error" ? `${e.name}: ` : "";
    return `${name}${e.message}`;
  }
  return String(e);
};

/**
 * Run the `cognit ask` command. Pure entry point — every I/O surface
 * goes through `deps`. Returns the process exit code; callers
 * translate that into a `process.exit` or test assertion.
 *
 * Exit codes follow spec §3:
 *   0  success
 *   1  network / HTTP error from the Gateway
 *   2  missing model, missing env, missing file, unknown MIME,
 *      clipboard unsupported, stdin ambiguous
 *   3  model not in the Gateway catalog (catchable from generateText)
 *   130  SIGINT
 */
export const runAsk = async (opts: AskOptions, deps: AskDeps = defaultDeps()): Promise<number> => {
  // SIGINT → exit 130. We let the in-flight `generateText` settle via
  // its own abort path; the listener only flips the exit code so the
  // process exits cleanly once the awaited promise resolves.
  let sigintReceived = false;
  const removeSigint = deps.installSigintHandler(() => {
    sigintReceived = true;
  });
  try {
    // 1. Project root. Missing → exit 2 (same shape as `agent run`).
    const root = deps.findProjectRoot();
    if (root === null) {
      deps.stderr("cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n");
      deps.setExitCode(2);
      return 2;
    }

    // 2. Config. Read + parse. Schema errors exit 2 (CLI argument class).
    let config: CognitConfig;
    try {
      config = await deps.readConfig(deps.projectPaths(root).config);
    } catch (e) {
      deps.stderr(`cognit: failed to read config: ${errorLabel(e)}\n`);
      deps.setExitCode(2);
      return 2;
    }

    // 3. Model resolution. The canonical 'no model configured' error
    //    comes from `resolveModel` itself (matches spec AC #8).
    let model: string;
    try {
      model = resolveModel(config, "ask", opts.model);
    } catch (e) {
      deps.stderr(`cognit: ${errorLabel(e)}\n`);
      deps.setExitCode(2);
      return 2;
    }

    // 4. API key check. Reading here gives a clean env-var error
    //    before the Gateway SDK's internal check fires. `resolveApiKey`
    //    matches spec AC #7's message verbatim.
    try {
      resolveApiKey(config, model);
    } catch (e) {
      deps.stderr(`cognit: ${errorLabel(e)}\n`);
      deps.setExitCode(2);
      return 2;
    }

    // 5. Read stdin (if piped). We always read first because
    //    `autoDetectInput` needs both `stdinIsPiped` and the first 16
    //    bytes for the stdin-binary heuristic.
    const stdin = await deps.readStdin();

    // 6. Resolve which input source to use. `autoDetectInput`
    //    respects the spec's --input-first → piped-stdin → null order.
    let source: InputSource | null;
    try {
      source = await deps.multimodal.autoDetectInput({
        ...(opts.input !== undefined ? { explicit: opts.input } : {}),
        stdinIsPiped: stdin.piped,
        stdinFirstBytes: stdin.bytes.subarray(0, 16),
      });
    } catch (e) {
      deps.stderr(`cognit: ${errorLabel(e)}\n`);
      deps.setExitCode(2);
      return 2;
    }

    // 7. No explicit source + TTY + clipboard has image → clipboard.
    //    `autoDetectInput` returns null in that case; the CLI bridges
    //    the gap by probing the clipboard here. Spec §3 step 3.
    if (source === null && !stdin.piped && deps.multimodal.isClipboardSupported()) {
      source = { kind: "clipboard" };
    }

    // 8. Resolve the source into bytes + classify. Text stdin is
    //    folded into the prompt; binary stdin becomes an attachment.
    let attachment: Attachment | null = null;
    let stdinTextForPrompt: string | null = null;

    if (source !== null) {
      if (source.kind === "stdin") {
        if (!stdin.piped) {
          deps.stderr("cognit: stdin source requested but no bytes piped\n");
          deps.setExitCode(2);
          return 2;
        }
        const cls = deps.multimodal.classifyStdin(stdin.bytes);
        if (cls === "text") {
          stdinTextForPrompt = stdin.bytes.toString("utf-8");
        } else if (cls === "binary") {
          try {
            attachment = await deps.multimodal.resolveInput(source, stdin.bytes);
          } catch (e) {
            deps.stderr(`cognit: ${errorLabel(e)}\n`);
            deps.setExitCode(2);
            return 2;
          }
        } else {
          // unknown → spec §3 stdin ambiguity error
          const hex = stdin.bytes.subarray(0, 16).toString("hex");
          deps.stderr(
            `cognit: stdin: cannot determine text vs binary (first bytes: ${hex})\n`,
          );
          deps.setExitCode(2);
          return 2;
        }
      } else {
        try {
          attachment = await deps.multimodal.resolveInput(source);
        } catch (e) {
          deps.stderr(`cognit: ${errorLabel(e)}\n`);
          deps.setExitCode(2);
          return 2;
        }
        // Text attachments: fold into the prompt so the operator
        // can pipe a file instead of typing the prompt.
        if (attachment.type === "file" && attachment.mime.startsWith("text/")) {
          stdinTextForPrompt = attachment.data.toString("utf-8");
        }
      }
    }

    // 9. Prompt assembly. --prompt + stdin text joined by \n\n.
    //    Empty after assembly → exit 2 (spec: prompt required when
    //    no text source is available).
    const promptParts: string[] = [];
    if (opts.prompt !== undefined && opts.prompt.length > 0) {
      promptParts.push(opts.prompt);
    }
    if (stdinTextForPrompt !== null && stdinTextForPrompt.length > 0) {
      promptParts.push(stdinTextForPrompt);
    }
    if (promptParts.length === 0) {
      deps.stderr(
        "cognit: --prompt is required (no stdin text, no --input text attachment)\n",
      );
      deps.setExitCode(2);
      return 2;
    }
    const finalPrompt = promptParts.join("\n\n");

    // 10. Build the Gateway model. This re-reads the env via
    //     `gatewayModelFor`; if the env disappeared between step 4
    //     and now (e.g. test fixtures), the same canonical error
    //     message fires here.
    let sdkModel;
    try {
      sdkModel = deps.gatewayModel(config.llm, model);
    } catch (e) {
      deps.stderr(`cognit: ${errorLabel(e)}\n`);
      deps.setExitCode(2);
      return 2;
    }

    // 11. Compose the user message. Spec §3 prompt assembly.
    const contentParts: ContentPart[] = [{ type: "text", text: finalPrompt }];
    if (attachment !== null) {
      contentParts.push(attachmentToContentPart(attachment));
    }

    // 12. Optional generation knobs. Parsed here so the values are
    //     validated once and forwarded as numbers (generateText's
    //     signature expects numeric types, not strings).
    const maxTokens = parseMaxTokens(opts.maxOutputTokens);
    const temperature = parseTemperature(opts.temperature);

    // 13. Call generateText. Network / model / HTTP errors → exit 1
    //     per spec §3. The Gateway SDK throws with the upstream
    //     status code embedded; we treat any non-AbortError throw as
    //     an HTTP/network class failure.
    let result;
    try {
      const args: Parameters<typeof generateText>[0] = {
        model: sdkModel as Parameters<typeof generateText>[0]["model"],
        messages: [{ role: "user", content: contentParts }],
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      };
      result = await deps.generateText(args);
    } catch (e) {
      deps.stderr(`cognit: ${errorLabel(e)}\n`);
      deps.setExitCode(1);
      return 1;
    }

    if (sigintReceived) {
      deps.setExitCode(130);
      return 130;
    }

    // 14. Emit the response.
    const text = result.text;
    // AI SDK v6 renamed the token fields: `promptTokens` →
    // `inputTokens`, `completionTokens` → `outputTokens`. The
    // Gateway's `--json` envelope uses the spec §3 names so we map.
    const promptTokens = result.usage?.inputTokens ?? 0;
    const completionTokens = result.usage?.outputTokens ?? 0;

    if (getOutputMode() === "json") {
      const envelopeData: AskEnvelopeData = {
        schema_version: "1",
        model,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        text,
        attachments: envelopeAttachments(attachment),
      };
      deps.stdout(JSON.stringify(envelope("ask", envelopeData), null, 2) + "\n");
    } else {
      deps.stdout(`${text}\n`);
    }
    return 0;
  } finally {
    removeSigint();
  }
};

const parseMaxTokens = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
};

const parseTemperature = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const t = Number.parseFloat(raw);
  if (!Number.isFinite(t)) return undefined;
  return t;
};

/**
 * Wire `cognit ask` into the commander program. Called from
 * `index.ts` alongside the other commands.
 */
export function registerAsk(program: Command): void {
  program
    .command("ask")
    .description("one-shot LLM query with optional multimodal input")
    .option("-p, --prompt <text>", "user prompt")
    .option("-m, --model <id>", "model override (else from config)")
    .option(
      "--input <source>",
      "input source: <path> | <url> | - | clipboard",
    )
    .option(
      "--max-output-tokens <n>",
      "cap output length",
      (v: string) => v,
    )
    .option(
      "--temperature <float>",
      "sampling temperature",
      (v: string) => v,
    )
    .action(async (opts: AskOptions) => {
      const code = await runAsk(opts);
      if (code !== 0 && process.exitCode === undefined) {
        process.exitCode = code;
      }
    });
}

// Type re-exports for tests that want to construct `AskDeps` directly.
export type { ContentPart, AskEnvelopeData, AskAttachment };
