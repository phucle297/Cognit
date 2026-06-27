# Cognit Hooks

External AI CLIs (Claude Code, Codex, Gemini CLI, OpenCode, …)
publish events to Cognit by writing atomic JSON files into
`.cognit/inbox/`. The watcher (`cognit inbox --watch`) validates
each file against the Effect Schema registry, calls
`SessionService.appendEvent`, and moves it to `.cognit/inbox/processed/`.
On failure the file moves to `.cognit/inbox/_error/` with a sidecar
`<name>.reason.txt` whose first line is `"<category>: <reason>"`.

Per-provider wiring lives in the linked provider pages
([claude-code](./claude-code.md), [codex](./codex.md),
[opencode](./opencode.md), [gemini-cli](./gemini-cli.md)). Each
provider page is a thin wrapper — install command + the host CLI's
hook event mapping + the payload shape. Producer scripts and
shared algorithms live below in **Common behavior**.

---

## Shipped producers

Reference producer scripts ship at the repo-root `hooks/` directory
(this `docs/hooks/` tree is documentation, not source). Each emits
envelope v1.2.0 FLAT (`actor_name` / `actor_type` at the top level,
no nested `actor`) matching `packages/wrap/src/index.ts:72`
(`WRAP_SCHEMA_VERSION = "1.2.0"`).

| Provider       | Source path                        | Host hook event      |
| -------------- | ---------------------------------- | -------------------- |
| Claude Code    | `hooks/claude-code/cc-post.sh`     | `PostToolUse`        |
| Claude Code    | `hooks/claude-code/cc-pre.sh`      | `PreToolUse`         |
| Codex CLI      | `hooks/codex/codex-post.sh`        | `PostToolUse`        |
| OpenCode       | `hooks/opencode/cognit.ts`         | `tool.execute.after` |
| Gemini CLI     | `hooks/gemini-cli/gemini-hooks.json` | `AfterTool`        |

Install:

```bash
mkdir -p ~/.cognit/hooks
install -m 0755 hooks/claude-code/cc-post.sh  ~/.cognit/hooks/cc-post.sh
install -m 0755 hooks/claude-code/cc-pre.sh   ~/.cognit/hooks/cc-pre.sh
install -m 0755 hooks/codex/codex-post.sh     ~/.cognit/hooks/codex-post.sh
cp hooks/gemini-cli/gemini-hooks.json         ~/.cognit/hooks/gemini-hooks.json
cp hooks/opencode/cognit.ts                   ~/.cognit/hooks/cognit.ts
```

---

## Common behavior

Every shipped producer (shell script or TypeScript plugin) follows
the same three algorithms. Provider pages link here instead of
duplicating them.

### Session id resolution

The Cognit `session_id` written into each envelope is resolved in
this order:

1. **`$COGNIT_SESSION_ID` env var** — set by
   `eval "$(cognit init --shell)"` in the current shell.
2. **Sticky pointer** at `./.cognit/current-session` — a plain-text
   ULID written by `cognit session create` / `cognit session resume`
   (`apps/cli/src/current-session.ts`).
3. **Placeholder ULID** (`01HXXXXXXXXXXXXXXXXXXXXXXXX`) — the
   watcher still parses the envelope and the `unknown_session_id`
   sidecar fires on first run. This is the documented bootstrap
   flow when no session is bound yet.

The host CLI's own `.session_id` (Claude Code, Codex, Gemini CLI) is
**deliberately not used** — the two namespaces are unrelated, and
writing an unknown session id into the inbox triggers
`unknown_session_id` rejection. Bind a Cognit session first via
`cognit session create`, then start the AI tool's turn.

### Atomic-write protocol

The protocol in `packages/wrap/src/atomic-write.ts::atomicWriteJson`
is the authoritative implementation. Shell and TS producers mirror
it step-for-step:

1. Compute `<session-id>-<event-id>.json` (the eventual file name).
2. Open `<file>.tmp` with `O_CREAT | O_EXCL | O_WRONLY` (mode `0o600`)
   — refuses to overwrite a leftover `.tmp` from a prior crash.
3. Write the JSON bytes.
4. `fsync` the temp file's fd (bytes hit disk before the rename).
5. Close the fd.
6. `rename` `<file>.tmp` → `<file>` (atomic on the same filesystem).

Shell scripts perform steps 2-6 in one Python invocation so the
fsync is guaranteed to land on the same fd the bytes were written
to (a `printf > tmp && python fsync tmp` split loses the guarantee
if bash-side writes have not flushed to the kernel page cache
before Python reopens the file).

### Inbox resolution

The destination directory is resolved in this order:

1. **`$COGNIT_INBOX` env var** (set by
   `eval "$(cognit init --shell)"`).
2. **Default**: `<projectRoot>/.cognit/inbox/` — Cognit is
   per-project local-first. The producer script resolves the
   project root from its CWD (the project the AI tool was launched
   from).

`~/.cognit/inbox/` is **not** a built-in default — it is only used
when `$COGNIT_INBOX` is explicitly set to that path.

### Failure categories

The watcher writes `<name>.reason.txt` sidecars with one of these
canonical categories (declared in
`packages/db/src/inbox-sidecar.ts`):

- `invalid_json` — file does not parse as JSON.
- `unknown_session_id` — `session_id` is not a Cognit session ULID.
- `schema_validation_failure` — envelope decoded but does not
  satisfy the version-keyed payload schema.
- `payload_schema_unknown` — `version` is not in
  `PAYLOAD_SCHEMAS_BY_VERSION` (no schema map to validate against).
- `actor_not_registered` — `actor_name` is not in the `actors` table.
- `invalid_actor_type` — `actor_type` is not the literal `"worker"`.
- `invalid_envelope` — envelope is not an object or has the wrong
  shape for the EnvelopeSchema.

---

## Provider guides

Each provider page is intentionally short: install command, host
hook event mapping, payload shape. All shared algorithms point back
to **Common behavior** above.

- [claude-code](./claude-code.md)
- [codex](./codex.md)
- [opencode](./opencode.md)
- [gemini-cli](./gemini-cli.md)
