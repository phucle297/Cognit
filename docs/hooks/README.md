# Cognit Hooks

External AI CLIs (Claude Code, Codex, Gemini CLI, OpenCode, …)
publish events to Cognit by writing atomic JSON files into
`.cognit/inbox/`. The watcher (`cognit inbox --watch`) validates
each file against the Effect Schema registry, calls
`SessionService.appendEvent`, and moves it to `.cognit/processed/`.
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

| Provider       | Source path                          | Host hook event      |
| -------------- | ------------------------------------ | -------------------- |
| Claude Code    | `hooks/claude-code/cc-post.sh`       | `PostToolUse`        |
| Claude Code    | `hooks/claude-code/cc-pre.sh`        | `PreToolUse`         |
| Codex CLI      | `hooks/codex/codex-post.sh`          | `PostToolUse`        |
| Codex CLI      | `hooks/codex/codex-pre.sh`           | `PreToolUse`         |
| OpenCode       | `hooks/opencode/cognit.ts`           | `tool.execute.after` |
| Gemini CLI     | `hooks/gemini-cli/gemini-post.sh`    | `AfterTool`          |

Install:

```bash
mkdir -p ~/.cognit/hooks
install -m 0755 hooks/claude-code/cc-post.sh  ~/.cognit/hooks/cc-post.sh
install -m 0755 hooks/claude-code/cc-pre.sh   ~/.cognit/hooks/cc-pre.sh
install -m 0755 hooks/codex/codex-post.sh     ~/.cognit/hooks/codex-post.sh
install -m 0755 hooks/codex/codex-pre.sh      ~/.cognit/hooks/codex-pre.sh
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

1. **`$COGNIT_SESSION_ID` env var** — exported by
   `eval "$(cognit env --shell)"` (read from
   `.cognit/current-session`, which `cognit session create` /
   `cognit session resume` keeps up to date). Omitted from the shell
   output before the first session exists.
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

### Orphan `.tmp` cleanup

The watcher **ignores** every path ending in `.tmp`. On a producer
crash mid-write, leftovers can accumulate and block a later write of
the same name (`O_EXCL`). Clean them with:

```bash
cognit inbox --clean-tmp                 # delete .tmp older than cleanup.inbox_tmp_max_age_days (default 30)
cognit inbox --clean-tmp --dry-run       # list only
cognit inbox --clean-tmp --max-age-days 0  # delete every orphan .tmp
cognit --json inbox --clean-tmp          # stable JSON for AI / scripts
```

Only top-level `.cognit/inbox/*.tmp` files are considered — never
complete `.json` envelopes, `_error/`, or `processed/`. Config key:
`cleanup.inbox_tmp_max_age_days` in `cognit.yaml`.

### Inbox resolution

The destination directory is resolved in this order:

1. **`$COGNIT_INBOX` env var** (set by
   `eval "$(cognit env --shell)"`).
2. **Default**: `<projectRoot>/.cognit/inbox/` — Cognit is
   per-project local-first. The producer script resolves the
   project root from its CWD (the project the AI tool was launched
   from).

`~/.cognit/inbox/` is **not** a built-in default — it is only used
when `$COGNIT_INBOX` is explicitly set to that path.

### Known-files allowlist (`~/.cognit/known-files.txt`)

The Claude Code and Codex pre-tool producers
(`hooks/claude-code/cc-pre.sh`, `hooks/codex/codex-pre.sh`) suppress
`hypothesis_created` events for paths you have marked as "already
mapped" — files the agent has seen enough times that re-emitting a
hypothesis on every read would just spam the inbox.

**Location**: per-user, at `~/.cognit/known-files.txt` (NOT inside
the project; this is a personal preference). Cognit never creates or
modifies the file — it is yours to manage.

**Format**: one absolute path per line, no globbing. Matched with
`grep -Fxq` (whole-line, literal), so the comparison is exact and
case-sensitive. Lines starting with `#` and blank lines are ignored
by your editor / shell tooling but are also matched literally by the
producer — keep the file clean.

**Example** (`~/.cognit/known-files.txt`):

```text
# Files I have already explored — skip hypothesis_created for these.
/home/you/projects/foo/README.md
/home/you/projects/foo/src/index.ts
```

**Workflow**: when a pre-tool event fires, the script extracts
`tool_input.file_path` (or the Claude Code / Codex equivalent) and
checks it against the file. A match returns exit 0 (the agent sees
"do not block"); a miss proceeds with the normal
`hypothesis_created` envelope.

`cognit init` does NOT create this file. Add entries as you go or
seed it manually before running the agent.

### Failure categories

The watcher writes `<name>.reason.txt` sidecars with one of these
canonical categories (declared in
`packages/db/src/inbox-sidecar.ts`):

- `invalid_json` — file does not parse as JSON.
- `unknown_session_id` — `session_id` is not a Cognit session ULID.
- `schema_validation_failure` — envelope decoded but does not
  satisfy the version-keyed payload schema. This also covers
  unknown `(version, type)` pairs and unknown version literals
  (the envelope schema accepts `1.0.0`, `1.1.0`, and
  `CURRENT_VERSION`; anything else surfaces here).
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
