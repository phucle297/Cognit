/**
 * apps/cli/test/ask.test.ts — `cognit ask` command.
 *
 * Spec: docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md §3.
 *
 * Coverage by category:
 *
 *   Exit codes (spec §3):
 *     1. missing project root → exit 2 with canonical "Run cognit init" message
 *     2. missing model → exit 2 with "no model configured (set llm.default_model or pass --model)"
 *     3. missing env → exit 2 with "required env <NAME> not set (source: llm.api_key_env)"
 *     4. file source: path not found → exit 2 (MultimodalError)
 *     5. stdin ambiguous → exit 2 with "stdin: cannot determine text vs binary"
 *     6. clipboard unsupported → exit 2 with platform name
 *     7. --prompt required when no text source → exit 2
 *     8. proxy network error → exit 1
 *     9. SIGINT received → exit 130
 *
 *   Output (spec §3):
 *    10. text mode prints model response on stdout
 *    11. --json emits stable v1 envelope with schema_version, model,
 *         text, attachments (token counts are 0 — direct fetch path
 *         doesn't expose them)
 *    12. attachments list is empty when no attachment
 *    13. attachments list includes image mime+size when image present
 *    14. attachments list includes file mime+filename when file present
 *
 *   Input resolution (spec §3):
 *    15. --input file path → resolveInput called with file source
 *    16. --input clipboard + supported → clipboard source
 *    17. no --input + stdin piped + binary → binary attachment
 *    18. no --input + stdin piped + text → text folded into prompt
 *    19. no --input + TTY + clipboard supported → clipboard source used
 *    20. no --input + TTY + clipboard unsupported → text-only prompt
 *
 *   Prompt assembly:
 *    21. --prompt alone → prompt as-is
 *    22. --prompt + stdin text → joined with \n\n
 *    23. stdin text alone (no --prompt) → text becomes prompt
 *
 *   CLI registration:
 *    24. `cognit ask --help` exits 0 and documents --prompt, --input, --model
 *         (`--json` is a global flag on the root program, not on `ask`,
 *         so it does not appear in `ask --help` output.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseCognitConfig } from "@cognit/core/config";
import {
  runAsk,
  type AskDeps,
  type AskMultimodalDeps,
} from "../src/commands/ask.js";
import { setOutputMode } from "../src/output.js";

// --- env lifecycle -----------------------------------------------------

/**
 * `resolveApiKey` (called from runAsk via config-resolver) reads
 * `process.env` directly. Tests manage `process.env` for the env-
 * related cases so the resolved key matches what the command sees.
 * The new schema defaults `llm.api_key_env` to `LITELLM_MASTER_KEY`.
 */
const ENV_KEY = "LITELLM_MASTER_KEY";
const SAVED_ENV: Record<string, string | undefined> = {};

const setEnv = (val: string | undefined): void => {
  if (val === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = val;
};

beforeEach(() => {
  SAVED_ENV[ENV_KEY] = process.env[ENV_KEY];
  // Default: env set. Individual tests that need missing-env clear it.
  setEnv("sk-litellm-fake");
});

afterEach(() => {
  const v = SAVED_ENV[ENV_KEY];
  if (v === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = v;
  setOutputMode("text");
});

// --- test harness ------------------------------------------------------

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const TEXT_BYTES = Buffer.from("hello, multimodal\n", "utf-8");

/** Record bag that mirrors what `makeDeps` collects. */
interface TestRig {
  deps: AskDeps;
  stdoutLines: string[];
  stderrLines: string[];
  exitCode: number | undefined;
  fireSigint: () => void;
  calls: {
    resolveInput: Array<[unknown, unknown?]>;
    classifyStdin: Array<[Buffer]>;
    complete: Array<[unknown]>;
  };
}

/**
 * Build a deps object whose defaults emulate the real command's
 * happy path. Tests then mutate the returned rig's fields directly.
 *
 * The trick to making overrides stick: build a fresh `multimodal`
 * object per call so a test that overrides ONE field doesn't
 * accidentally inherit (and need to disable) every other field.
 */
const makeRig = (overrides: {
  findProjectRoot?: () => string | null;
  readStdin?: () => Promise<{ bytes: Buffer; piped: boolean }>;
  autoDetectInput?: AskMultimodalDeps["autoDetectInput"];
  resolveInput?: AskMultimodalDeps["resolveInput"];
  classifyStdin?: AskMultimodalDeps["classifyStdin"];
  isClipboardSupported?: AskMultimodalDeps["isClipboardSupported"];
  openaiComplete?: AskDeps["openaiComplete"];
  readConfig?: AskDeps["readConfig"];
} = {}): TestRig => {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let exitCode: number | undefined;
  const sigintHandlers: Array<() => void> = [];
  const calls: TestRig["calls"] = {
    resolveInput: [],
    classifyStdin: [],
    complete: [],
  };

  const configWithModel = parseCognitConfig({
    project: { name: "ask-test" },
    llm: { default_model: "claude-sonnet-4-6" },
  });

  const multimodal: AskMultimodalDeps = {
    autoDetectInput: overrides.autoDetectInput ?? (async () => null),
    resolveInput: overrides.resolveInput ?? (async () => ({
      type: "image" as const,
      data: PNG_BYTES,
      mime: "image/png",
    })),
    classifyStdin: overrides.classifyStdin ?? (() => "unknown" as const),
    isClipboardSupported: overrides.isClipboardSupported ?? (() => false),
  };
  // Wrap the resolveInput / classifyStdin / complete so we can
  // record the call args for tests that assert on input resolution.
  const wrappedResolveInput = (
    src: Parameters<AskMultimodalDeps["resolveInput"]>[0],
    stdinBytes?: Parameters<AskMultimodalDeps["resolveInput"]>[1],
  ) => {
    calls.resolveInput.push([src, stdinBytes]);
    return multimodal.resolveInput(src, stdinBytes);
  };
  const wrappedClassifyStdin = (b: Buffer) => {
    calls.classifyStdin.push([b]);
    return multimodal.classifyStdin(b);
  };

  // The factory returns a completion closure; tests that need to
  // assert on the call args read `calls.complete` instead of
  // inspecting the closure. `openaiComplete(llm)` returns
  // `(args) => Promise<string>` so we record the args the runAsk
  // path passes in.
  type CompleteArgs = { prompt: string; model: string; signal?: AbortSignal };
  const recording = (inner: (a: CompleteArgs) => Promise<string>) =>
    (args: CompleteArgs) => {
      calls.complete.push([args]);
      return inner(args);
    };
  // `AskDeps.openaiComplete` is `(llm) => (args) => Promise<string>`.
  // Build a recording wrapper around it (default + override).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = ((cfg: any) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recording(((overrides.openaiComplete as any) ?? (() => async () => "fake-model-response"))(cfg))) as AskDeps["openaiComplete"];
  void wrapped;

  const deps: AskDeps = {
    readConfig: overrides.readConfig ?? (async () => configWithModel),
    findProjectRoot: overrides.findProjectRoot ?? (() => "/tmp/ask-test-project"),
    projectPaths: ((root: string) => ({
      root,
      dir: `${root}/.cognit`,
      config: `${root}/.cognit/cognit.yaml`,
      db: `${root}/.cognit/cognit.db`,
      gitignore: `${root}/.cognit/.gitignore`,
      inbox: `${root}/.cognit/inbox`,
      inboxError: `${root}/.cognit/inbox/_error`,
      artifacts: `${root}/.cognit/artifacts`,
      artifactsCurated: `${root}/.cognit/artifacts/curated`,
      snapshots: `${root}/.cognit/snapshots`,
      archive: `${root}/.cognit/archive`,
      currentSession: `${root}/.cognit/current-session`,
      currentSessionTmp: `${root}/.cognit/current-session.tmp`,
    })) as AskDeps["projectPaths"],
    readStdin: overrides.readStdin ?? (async () => ({ bytes: Buffer.alloc(0), piped: false })),
    openaiComplete: wrapped,
    multimodal: {
      autoDetectInput: multimodal.autoDetectInput,
      resolveInput: wrappedResolveInput as AskMultimodalDeps["resolveInput"],
      classifyStdin: wrappedClassifyStdin,
      isClipboardSupported: multimodal.isClipboardSupported,
    },
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    setExitCode: (code) => {
      exitCode = code;
    },
    getEnv: () => process.env[ENV_KEY],
    installSigintHandler: (handler) => {
      sigintHandlers.push(handler);
      return () => {
        const i = sigintHandlers.indexOf(handler);
        if (i >= 0) sigintHandlers.splice(i, 1);
      };
    },
  };

  return {
    deps,
    stdoutLines,
    stderrLines,
    get exitCode() {
      return exitCode;
    },
    fireSigint: () => {
      for (const h of sigintHandlers) h();
    },
    calls,
  };
};

// --- exit codes --------------------------------------------------------

describe("runAsk — exit codes (spec §3)", () => {
  it("1. missing project root → exit 2 with 'Run cognit init' message", async () => {
    const rig = makeRig({ findProjectRoot: () => null });
    const code = await runAsk({ prompt: "x" }, rig.deps);
    expect(code).toBe(2);
    expect(rig.stderrLines.join("")).toMatch(/Run `cognit init` first/);
  });

  it("2. missing model → exit 2 with canonical 'no model configured' message", async () => {
    const cfgNoModel = parseCognitConfig({
      project: { name: "x" },
      llm: { default_model: undefined },
    });
    const rig = makeRig({ readConfig: async () => cfgNoModel });
    const code = await runAsk({ prompt: "x" }, rig.deps);
    expect(code).toBe(2);
    expect(rig.stderrLines.join("")).toMatch(
      "no model configured (set llm.default_model or pass --model)",
    );
  });

  it("3. missing env → exit 2 with 'required env <NAME> not set' message", async () => {
    setEnv(undefined);
    const rig = makeRig();
    const code = await runAsk({ prompt: "x" }, rig.deps);
    expect(code).toBe(2);
    expect(rig.stderrLines.join("")).toMatch(
      "required env LITELLM_MASTER_KEY not set (source: llm.api_key_env)",
    );
  });

  it("4. file source: path not found → exit 2 (delegated to multimodal)", async () => {
    const rig = makeRig({
      autoDetectInput: async () => ({ kind: "file", path: "/no/such" }),
      resolveInput: async () => {
        throw new Error("file: cannot read /no/such: ENOENT");
      },
    });
    const code = await runAsk({ prompt: "x", input: "/no/such" }, rig.deps);
    expect(code).toBe(2);
    expect(rig.stderrLines.join("")).toMatch(/cannot read/);
  });

  it("5. stdin ambiguous → exit 2 with 'cannot determine text vs binary'", async () => {
    const rig = makeRig({
      readStdin: async () => ({
        bytes: Buffer.from([0xc3, 0x28, 0xa0, 0xa1]), // invalid UTF-8, no NUL
        piped: true,
      }),
      autoDetectInput: async () => ({ kind: "stdin" }),
      classifyStdin: () => "unknown" as const,
    });
    const code = await runAsk({ prompt: "x" }, rig.deps);
    expect(code).toBe(2);
    expect(rig.stderrLines.join("")).toMatch(
      /cannot determine text vs binary/,
    );
  });

  it("6. clipboard unsupported → exit 2 with platform name", async () => {
    const rig = makeRig({
      autoDetectInput: async () => ({ kind: "clipboard" }),
      isClipboardSupported: () => false,
      resolveInput: async () => {
        throw new Error("clipboard image read not supported on this platform (plan9)");
      },
    });
    const code = await runAsk({ prompt: "x", input: "clipboard" }, rig.deps);
    expect(code).toBe(2);
    expect(rig.stderrLines.join("")).toMatch(/plan9/);
  });

  it("7. --prompt required when no text source → exit 2", async () => {
    const rig = makeRig({
      isClipboardSupported: () => false,
    });
    const code = await runAsk({}, rig.deps);
    expect(code).toBe(2);
    expect(rig.stderrLines.join("")).toMatch(/--prompt is required/);
  });

  it("8. proxy network error → exit 1", async () => {
    const rig = makeRig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiComplete: (() => async () => {
        throw new Error("ECONNREFUSED");
      }) as any,
    });
    const code = await runAsk({ prompt: "x" }, rig.deps);
    expect(code).toBe(1);
    expect(rig.stderrLines.join("")).toMatch(/ECONNREFUSED/);
  });

  it("9. SIGINT received during call → exit 130", async () => {
    const rig = makeRig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiComplete: (() => async () => {
        rig.fireSigint();
        return "after-sigint";
      }) as any,
    });
    const code = await runAsk({ prompt: "x" }, rig.deps);
    expect(code).toBe(130);
  });
});

// --- output (text + JSON envelope) --------------------------------------

describe("runAsk — output (spec §3)", () => {
  it("10. text mode prints model response on stdout", async () => {
    const rig = makeRig();
    const code = await runAsk({ prompt: "x" }, rig.deps);
    expect(code).toBe(0);
    expect(rig.stdoutLines.join("")).toContain("fake-model-response");
  });

  it("11. --json emits stable v1 envelope with required fields", async () => {
    setOutputMode("json");
    const rig = makeRig();
    const code = await runAsk({ prompt: "x" }, rig.deps);
    expect(code).toBe(0);
    const env = JSON.parse(rig.stdoutLines.join("")) as {
      version: number;
      kind: string;
      data: Record<string, unknown>;
    };
    expect(env.version).toBe(1);
    expect(env.kind).toBe("ask");
    expect(env.data.schema_version).toBe("1");
    expect(env.data.model).toBe("claude-sonnet-4-6");
    // Token counts are 0 because the direct `/v1/chat/completions`
    // fetch path doesn't expose them; downstream consumers should
    // treat them as best-effort.
    expect(env.data.prompt_tokens).toBe(0);
    expect(env.data.completion_tokens).toBe(0);
    expect(env.data.text).toBe("fake-model-response");
    expect(env.data.attachments).toEqual([]);
  });

  it("13. attachments list includes image mime+size when image present", async () => {
    setOutputMode("json");
    const rig = makeRig({
      autoDetectInput: async () => ({ kind: "file", path: "/some/image.png" }),
      resolveInput: async () => ({
        type: "image" as const,
        data: PNG_BYTES,
        mime: "image/png",
      }),
    });
    await runAsk({ prompt: "x", input: "/some/image.png" }, rig.deps);
    const env = JSON.parse(rig.stdoutLines.join("")) as {
      data: { attachments: ReadonlyArray<{ type: string; mime: string; size_bytes: number }> };
    };
    expect(env.data.attachments).toEqual([
      { type: "image", mime: "image/png", size_bytes: PNG_BYTES.length },
    ]);
  });

  it("14. attachments list includes file mime+filename when file present", async () => {
    setOutputMode("json");
    const rig = makeRig({
      autoDetectInput: async () => ({ kind: "file", path: "/some/doc.pdf" }),
      resolveInput: async () => ({
        type: "file" as const,
        data: Buffer.from("%PDF-1.4\nfake", "utf-8"),
        mime: "application/pdf",
        filename: "doc.pdf",
      }),
    });
    await runAsk({ prompt: "x", input: "/some/doc.pdf" }, rig.deps);
    const env = JSON.parse(rig.stdoutLines.join("")) as {
      data: { attachments: ReadonlyArray<{ type: string; mime: string; filename: string; size_bytes: number }> };
    };
    expect(env.data.attachments).toHaveLength(1);
    expect(env.data.attachments[0]).toMatchObject({
      type: "file",
      mime: "application/pdf",
      filename: "doc.pdf",
    });
  });
});

// --- input resolution (spec §3) -----------------------------------------

describe("runAsk — input resolution (spec §3)", () => {
  it("15. --input file path → resolveInput called with file source", async () => {
    const rig = makeRig({
      autoDetectInput: async () => ({ kind: "file", path: "/some/image.png" }),
    });
    await runAsk({ prompt: "x", input: "/some/image.png" }, rig.deps);
    expect(rig.calls.resolveInput[0]?.[0]).toEqual({
      kind: "file",
      path: "/some/image.png",
    });
  });

  it("16. --input clipboard + supported → clipboard source", async () => {
    const rig = makeRig({
      autoDetectInput: async () => ({ kind: "clipboard" }),
      isClipboardSupported: () => true,
    });
    await runAsk({ prompt: "x", input: "clipboard" }, rig.deps);
    expect(rig.calls.resolveInput[0]?.[0]).toEqual({ kind: "clipboard" });
  });

  it("17. no --input + stdin piped + binary → binary attachment", async () => {
    const rig = makeRig({
      readStdin: async () => ({ bytes: PNG_BYTES, piped: true }),
      autoDetectInput: async () => ({ kind: "stdin" }),
      classifyStdin: () => "binary" as const,
      resolveInput: async () => ({
        type: "image" as const,
        data: PNG_BYTES,
        mime: "image/png",
      }),
    });
    await runAsk({ prompt: "x" }, rig.deps);
    expect(rig.calls.resolveInput[0]?.[0]).toEqual({ kind: "stdin" });
    expect(rig.calls.resolveInput[0]?.[1]).toEqual(PNG_BYTES);
  });

  it("18. no --input + stdin piped + text → text folded into prompt", async () => {
    const rig = makeRig({
      readStdin: async () => ({ bytes: TEXT_BYTES, piped: true }),
      autoDetectInput: async () => ({ kind: "stdin" }),
      classifyStdin: () => "text" as const,
    });
    await runAsk({ prompt: "explain" }, rig.deps);
    expect(rig.calls.resolveInput).toHaveLength(0);
    const args = rig.calls.complete[0]?.[0] as { prompt: string };
    expect(args.prompt).toBe(`explain\n\nhello, multimodal\n`);
  });

  it("19. no --input + TTY + clipboard supported → clipboard source", async () => {
    const rig = makeRig({
      readStdin: async () => ({ bytes: Buffer.alloc(0), piped: false }),
      autoDetectInput: async () => null,
      isClipboardSupported: () => true,
    });
    await runAsk({ prompt: "what is this" }, rig.deps);
    expect(rig.calls.resolveInput[0]?.[0]).toEqual({ kind: "clipboard" });
  });

  it("20. no --input + TTY + clipboard unsupported → text-only prompt", async () => {
    const rig = makeRig({
      readStdin: async () => ({ bytes: Buffer.alloc(0), piped: false }),
      autoDetectInput: async () => null,
      isClipboardSupported: () => false,
    });
    await runAsk({ prompt: "just text" }, rig.deps);
    expect(rig.calls.resolveInput).toHaveLength(0);
    expect(rig.stdoutLines.join("")).toContain("fake-model-response");
  });
});

// --- prompt assembly ---------------------------------------------------

describe("runAsk — prompt assembly", () => {
  it("21. --prompt alone → prompt as-is", async () => {
    const rig = makeRig();
    await runAsk({ prompt: "just-prompt" }, rig.deps);
    const args = rig.calls.complete[0]?.[0] as { prompt: string };
    expect(args.prompt).toBe("just-prompt");
  });

  it("22. --prompt + stdin text → joined with \\n\\n", async () => {
    const rig = makeRig({
      readStdin: async () => ({ bytes: TEXT_BYTES, piped: true }),
      autoDetectInput: async () => ({ kind: "stdin" }),
      classifyStdin: () => "text" as const,
    });
    await runAsk({ prompt: "explain" }, rig.deps);
    const args = rig.calls.complete[0]?.[0] as { prompt: string };
    expect(args.prompt).toBe("explain\n\nhello, multimodal\n");
  });

  it("23. stdin text alone (no --prompt) → text becomes prompt", async () => {
    const rig = makeRig({
      readStdin: async () => ({ bytes: TEXT_BYTES, piped: true }),
      autoDetectInput: async () => ({ kind: "stdin" }),
      classifyStdin: () => "text" as const,
    });
    await runAsk({}, rig.deps);
    const args = rig.calls.complete[0]?.[0] as { prompt: string };
    expect(args.prompt).toBe("hello, multimodal\n");
  });
});

// --- CLI registration via spawnSync -------------------------------------

describe("cognit ask — CLI registration", () => {
  it("24. `cognit ask --help` exits 0 and documents --prompt, --input, --model", () => {
    const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
    const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");
    const r = spawnSync(TSX, [CLI_ENTRY, "ask", "--help"], {
      encoding: "utf8",
      cwd: "/tmp",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--prompt/);
    expect(r.stdout).toMatch(/--input/);
    expect(r.stdout).toMatch(/--model/);
  });
});