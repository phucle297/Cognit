# Gateway-routed LLM with multimodal input — design

**Date:** 2026-06-22
**Status:** design (awaiting user approval)
**Scope:** new `cognit ask` command + `cognit agent run` migration + config schema + multimodal input

## Problem

The current `cognit agent run --provider <name> --model <id>` requires the operator
to pick a provider on every invocation. Provider selection is a closed literal
(`anthropic | openai | google | ollama | mock`) baked into `@cognit/agent`. The
operator must set the matching env var per provider, and adding a new provider
(e.g. MiniMax, GLM, Qwen) requires code changes in both `@cognit/agent` and
`@cognit/llm`.

In practice the operator wants:

1. One env var (`AI_GATEWAY_API_KEY`) that covers every model — Vercel AI Gateway
   routes to the right provider.
2. Per-model key override for models that need a direct provider key.
3. No silent fallbacks. Missing env = explicit error.
4. A one-shot `cognit ask` command that takes a prompt and optional image/file
   attachments — separate from the supervisor loop, so ad-hoc queries do not
   pollute session state.
5. Multimodal input via auto-detected sources: local file path, URL, stdin pipe,
   OS clipboard.

## Goals

- **Config-driven**: model + key env come from `cognit.yaml` by default. Flags
  override config.
- **Gateway-routed**: Vercel AI Gateway is the default transport. Per-model key
  overrides still route through Gateway (just with a different key).
- **Multimodal `ask`**: `cognit ask` accepts images and files alongside text.
- **Back-compat for `agent run`**: `--provider` still works as a deprecated alias
  during a grace period; mapped to the equivalent Gateway model prefix.

## Non-goals

- Removing the supervisor loop's session-derived prompt. `agent run` stays
  state-driven. Multimodal input attaches to `cognit ask` only.
- Per-model `base_url` overrides. Out of scope. Add later if needed.
- Streaming output. Single-shot response text only. Add `--stream` later.
- System prompt override. Out of scope.

## Design

### 1. Config schema (`@cognit/core/config`)

Extend `CognitConfigSchema` with a new top-level `llm` block:

```yaml
llm:
  # Default API key env. Read at call time; covers all models unless overridden.
  api_key_env: AI_GATEWAY_API_KEY

  # Default model when no command-specific override exists and no --model flag.
  default_model: "MiniMax/MiniMax-M3"

  # Per-model overrides. Key only — routing still via Gateway.
  models:
    "anthropic/claude-sonnet-4-6":
      api_key_env: ANTHROPIC_API_KEY
    "glm/glm-4-plus":
      api_key_env: GLM_API_KEY
    "qwen/qwen-3-max":
      api_key_env: DASHSCOPE_API_KEY
    "openai/gpt-4o":
      api_key_env: OPENAI_API_KEY

  # Optional per-command defaults. Fall back to default_model.
  commands:
    ask:
      model: "MiniMax/MiniMax-M3"
    agent_run:
      model: "anthropic/claude-sonnet-4-6"
```

Three rules baked in:

1. **`llm.api_key_env`** — one env covers all models via Gateway.
2. **`llm.models.<model>.api_key_env`** — per-model override; still routes through
   Gateway, just with a different key.
3. **No fallback** — missing required env = error with the exact env var name in
   the message. No silent fallback to mock or other env.

### 2. Model + key resolution

Resolution order (highest priority first):

1. CLI flag (`--model`).
2. `llm.commands.<cmd>.model`.
3. `llm.default_model`.
4. Error: `cognit ask: no model configured (set llm.default_model or pass --model)`.

Key resolution for the resolved model:

1. `llm.models[<model>].api_key_env` if present.
2. `llm.api_key_env` otherwise.

Read env var. If missing → error:
`cognit ask: required env <NAME> not set (model <model>, source: llm.models.<model>.api_key_env or llm.api_key_env)`.

### 3. `cognit ask` command

**Surface**:

```
cognit ask [options] [--prompt <text>]

Options:
  -p, --prompt <text>      user prompt. Required only if no text source is available:
                             stdin not piped, no clipboard, no `--input` that is text.
  -m, --model <id>         model override (else from config)
  --input <source>         explicit input source:
                             <path>      local file (image or document)
                             <url>       fetch from URL
                             -           read bytes from stdin
                             clipboard   read from OS clipboard
  --max-output-tokens <n>  cap output length
  --temperature <float>    sampling temperature
  -j, --json               emit stable JSON envelope on stdout
  -h, --help               help
```

**Input resolution**:

1. `--input <source>` flag — exact source.
2. No `--input` + stdin piped (not TTY) → read stdin bytes.
3. No `--input` + stdin is TTY + OS clipboard has image → read clipboard.
4. Else → text-only prompt (no multimodal).

**Stdin auto text vs binary detection**:

- If first 8 bytes match a known binary magic (PNG/JPEG/GIF/WebP/PDF/ZIP) →
  treat as image/file attachment.
- Else if first N bytes are valid UTF-8 with no NUL characters → treat as text
  prompt (also: appended to `--prompt` if both given, separated by `\n\n`).
- Else → error `stdin: cannot determine text vs binary (first bytes: <hex>)`.

**MIME auto-detection** (file path): from extension first, then magic-number
sniff if extension unknown. Sniff table:

| Magic bytes (hex)             | MIME                |
|-------------------------------|---------------------|
| `89 50 4E 47 0D 0A 1A 0A`     | `image/png`         |
| `FF D8 FF`                    | `image/jpeg`        |
| `47 49 46 38`                 | `image/gif`         |
| `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` | `image/webp` |
| `25 50 44 46`                 | `application/pdf`   |
| `50 4B 03 04`                 | `application/zip`   |

Unknown → error with path.

**Output**:

- Default text: response text on stdout.
- `--json`: stable envelope:
  ```json
  {
    "schema_version": "1",
    "model": "anthropic/claude-sonnet-4-6",
    "prompt_tokens": 42,
    "completion_tokens": 128,
    "text": "...",
    "attachments": [{ "type": "image", "mime": "image/png", "size_bytes": 12345 }]
  }
  ```

**Errors** (typed, exit codes):

| Condition                                       | Exit code |
|-------------------------------------------------|-----------|
| Missing model (no flag, no config)              | 2         |
| Missing required env var                        | 2         |
| File path not found / unreadable                | 2         |
| Unknown MIME for attachment                     | 2         |
| Clipboard read not supported on this platform   | 2         |
| Model not in Gateway catalog                    | 3         |
| Network / HTTP error from Gateway               | 1         |
| Cancelled (SIGINT)                              | 130       |

### 4. `cognit agent run` migration

**Old**:
```
cognit agent run --session <id> --provider anthropic --model claude-sonnet-4-6
```

**New**:
```
cognit agent run --session <id>
# Model from llm.commands.agent_run.model → llm.default_model → --model flag
```

**Back-compat** (grace period):

- `--provider` still accepted. Maps to Gateway model prefix:
  - `anthropic` → `anthropic/<model>`
  - `openai` → `openai/<model>`
  - `google` → `google/<model>`
  - `ollama` → `ollama/<model>` (local adapter path, not Gateway)
  - `mock` → canned Layer (unchanged — does not reach Gateway)
- Stderr warning on first use: `--provider is deprecated, use --model with full Gateway string (e.g. anthropic/claude-sonnet-4-6)`.
- After grace period (one minor release): remove `--provider` entirely and drop
  the `AgentProvider` closed literal from `@cognit/agent`.

**Schema changes in `@cognit/agent`**:

- `AgentProvider` literal stays for back-compat but no longer drives routing.
- `AgentConfig.provider` becomes optional, only set when `--provider` is given
  or when the legacy `mock` path is used.
- `AgentConfig.model` stays free-form (already is).

**Supervisor prompt + multimodal**: `agent run` does NOT take `--input` or
`--image`. Prompt is session-derived. Multimodal is `cognit ask` only.

### 5. Multimodal input handler

`packages/llm/src/multimodal.ts` — pure module, no CLI deps.

```ts
type InputSource =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string }
  | { kind: "stdin" }
  | { kind: "clipboard" };

type Attachment =
  | { type: "image"; data: Buffer; mime: string }
  | { type: "file";  data: Buffer; mime: string; filename: string };

export declare function resolveInput(source: InputSource): Promise<Attachment>;
export declare function autoDetectInput(args: {
  explicit?: string;
  stdinIsPiped: boolean;
  stdinFirstBytes: Buffer;
}): Promise<InputSource>;
export declare function classifyStdin(firstBytes: Buffer): "text" | "binary" | "unknown";
export declare function sniffMime(firstBytes: Buffer, ext?: string): string | null;
```

**Clipboard abstraction** (`packages/llm/src/clipboard.ts`):

| Platform         | Command                                                  |
|------------------|----------------------------------------------------------|
| macOS            | `pbpaste` (returns PNG if clipboard has image)           |
| Linux X11        | `xclip -selection clipboard -t image/png -o`             |
| Linux Wayland    | `wl-paste -t image/png`                                  |
| WSL              | PowerShell `Get-Clipboard -Format Image` + base64 decode |
| Windows native   | PowerShell `Get-Clipboard`                               |
| Unsupported      | Error `clipboard image read not supported on this platform` |

**Prompt assembly** (in `cognit ask`):

- Text + attachments → `generateText({ model: gateway(model), messages: [{role:'user', content: [{type:'text', text: prompt}, ...attachments.map(toContentPart)]}] })`.
- Vercel AI SDK `gateway(modelString)` from `@ai-sdk/gateway` is the model
  factory. The key from resolution is passed via `gateway({ apiKey })` or via
  the env var the SDK reads (`AI_GATEWAY_API_KEY`).

### 6. Documentation updates

Files:

- `guide/en.md` and `guide/vi.md`:
  - **§2 Install**: add Gateway key env step.
  - **§4.3 Run the supervisor**: replace `--provider` examples with Gateway-style
    + config-driven.
  - **New §4.4 One-shot ask**: full `cognit ask` examples with multimodal.
  - **§18 Troubleshooting**: add rows for `missing env`, `no model configured`,
    `clipboard unsupported`.
- `README.md` — quickstart with `cognit ask` + minimal `cognit.yaml` snippet.

## Files to change

| Path                                                | Change                                              |
|-----------------------------------------------------|-----------------------------------------------------|
| `packages/core/src/config.ts`                       | Add `LlmConfig` schema, extend `CognitConfigSchema` |
| `packages/core/src/__tests__/config.test.ts`        | Add fixtures + tests for new `llm` block            |
| `packages/agent/src/agent-config.ts`                | Relax `AgentProvider` to optional, keep literal for back-compat |
| `packages/agent/src/__tests__/agent-config.test.ts` | Tests for relaxed schema                            |
| `packages/llm/src/multimodal.ts`                    | NEW: input resolution + magic-number MIME sniff     |
| `packages/llm/src/clipboard.ts`                     | NEW: OS clipboard abstraction                       |
| `packages/llm/src/gateway.ts`                       | NEW: `gatewayModel(cfg, modelId)` factory           |
| `packages/llm/src/index.ts`                         | Re-export new modules                               |
| `packages/llm/src/layer.ts`                         | Use `gatewayModel` instead of closed-literal switch |
| `packages/llm/src/provider.ts`                      | Keep for back-compat mock; add deprecation comments |
| `packages/llm/src/__tests__/multimodal.test.ts`     | NEW: input resolution tests                         |
| `packages/llm/src/__tests__/clipboard.test.ts`      | NEW: clipboard mock tests                           |
| `apps/cli/src/commands/ask.ts`                      | NEW: `cognit ask` command implementation            |
| `apps/cli/src/commands/agent.ts`                    | Drop `--provider` from primary; keep as deprecated  |
| `apps/cli/src/index.ts`                             | Register `ask` command                              |
| `apps/cli/src/layer-build.ts`                       | `agentConfigFromFlags` accepts new fields           |
| `apps/cli/src/config-resolver.ts`                   | NEW: shared model + key resolution                  |
| `apps/cli/src/__tests__/ask.test.ts`                | NEW: `cognit ask` integration tests                 |
| `guide/en.md`, `guide/vi.md`                        | Doc updates per Section 6                           |
| `README.md`                                         | Quickstart update                                   |

## Risks

- **WSL clipboard**: PowerShell `Get-Clipboard -Format Image` is the only path
  on WSL; must decode base64 from the returned string. Test coverage will mock
  the subprocess call; manual smoke test required on real WSL.
- **Vercel Gateway auth**: Per-model key override still routes through Gateway.
  Gateway must accept a non-default API key per request. If it does not, the
  override path falls back to direct provider SDK. Validate during impl.
- **Magic-number false positives**: Sniff table is short. Edge cases (e.g. a
  file that happens to start with PNG magic but is actually something else) will
  be misclassified. Acceptable trade-off — better than requiring the user to
  pass `--mime`.
- **Stdin text/binary heuristic**: ambiguous inputs error out. Operators can
  always be explicit via `--prompt` + `--input`.

## Acceptance criteria

1. `cognit ask --prompt "explain"` with `llm.default_model: MiniMax/MiniMax-M3`
   in config sends the request via Vercel Gateway and prints the response.
2. `cognit ask --model openai/gpt-4o --prompt "x"` overrides the config default.
3. `cognit ask --prompt "?" --input ./diagram.png` reads the local file and
   attaches it as an image part.
4. `cat img.png | cognit ask --prompt "?"` reads stdin bytes and attaches as
   image (magic-number sniff).
5. `echo "explain" | cognit ask` reads stdin as text prompt (no attachment).
6. `cognit ask --input clipboard --prompt "?"` on macOS reads the clipboard
   image; on an unsupported platform prints a clean error and exits 2.
7. Missing `AI_GATEWAY_API_KEY` errors with: `required env AI_GATEWAY_API_KEY
   not set (model <model>, source: llm.api_key_env)`.
8. Missing model (no flag, no config) errors with: `no model configured (set
   llm.default_model or pass --model)`.
9. `cognit agent run --session S --model anthropic/claude-sonnet-4-6` works
   without `--provider`.
10. `cognit agent run --session S --provider anthropic --model claude-sonnet-4-6`
    still works and emits the deprecation warning to stderr.
11. `--json` envelope on `cognit ask` matches the documented schema.
12. `guide/en.md` §4.3, §4.4 (new), §18 updated. `guide/vi.md` mirror updated.
    `README.md` quickstart shows `cognit ask` example.
