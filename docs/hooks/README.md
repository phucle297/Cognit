# Cognit Hooks

External AI CLIs (Claude Code, Codex, Gemini CLI, OpenCode, …)
publish events to Cognit by writing atomic JSON files into
`.cognit/inbox/`. The inbox is drained into the database **lazily**:
every read command (`cognit continue`, `cognit search`, `cognit
events`) validates each pending file against the Effect Schema
registry, resolves or creates the session, calls
`SessionService.appendEvent`, and moves it to `.cognit/processed/`.
On failure the file moves to `.cognit/inbox/_error/` with a sidecar
`<name>.reason.txt` whose first line is `"<category>: <reason>"`.

No background process is required for basic use. `cognit inbox
--watch` (a long-running chokidar watcher for real-time freshness)
and `cognit inbox --process` (a one-shot flush) remain as
**advanced/optional** knobs — see the inbox command reference in
[docs/cli.md](../cli.md). `cognit inbox --reprocess` re-runs every
file in `inbox/_error/` to salvage them after a Cognit upgrade or a
fix.

Per-provider wiring lives in the linked provider pages
([claude-code](./claude-code.md), [codex](./codex.md),
[opencode](./opencode.md), [gemini-cli](./gemini-cli.md), [grok-build](./grok-build.md)). Each
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
| Grok Build     | `hooks/claude-code/cc-post.sh` (shared, host-detected) | `PostToolUse` |
| Grok Build     | `hooks/claude-code/cc-pre.sh` (shared, host-detected)  | `PreToolUse`  |

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

Shell producers are **CLI-agnostic**: they multi-path parse tool fields
(Claude snake_case, Grok/Cursor camelCase, Codex `name`/`arguments`) and
set `source.tool` from runtime detection (`GROK_*` env, JSON shape, installer fallback).
Minimum supported hosts: **Claude Code**, **Codex CLI**, **Grok Build**.


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
3. **Placeholder ULID** (`01HXXXXXXXXXXXXXXXXXXXXXXX`) — when no
   session is bound yet, the producer writes the placeholder. On
   drain, the consumer **lazily creates** a session and rewrites
   the pointer (mirroring the CLI verb path), so the file is
   ingested, not rejected. This is the default out-of-the-box flow.

The host CLI's own `.session_id` (Claude Code, Codex, Gemini CLI) is
**deliberately not used** — the two namespaces are unrelated. You do
**not** need to run `cognit session create` before starting a turn:
the consumer auto-binds a session on first use. `cognit session
create` / `resume` remain available as advanced commands for users
who want to name or fork a session explicitly.

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

### Near-realtime drain (`$COGNIT_REALTIME`, optional)

By default producers only **write** inbox files. Read commands
(`continue` / `search` / `events`) drain lazily. For near-realtime
without a daemon:

1. Set `inbox.realtime: true` in `.cognit/cognit.yaml`.
2. Re-export env: `eval "$(cognit env --shell)"` (exports
   `COGNIT_REALTIME=1`).
3. Producers fire-and-forget `cognit inbox --process` after each
   successful atomic write. Failures are ignored; the host CLI is
   never blocked.

Alternatives for continuous freshness: `cognit inbox --watch`,
`cognit inbox --install-watch` (systemd/launchd unit), or
`cognit-server --watch-inbox`.

### Hook latency budget (D-M4-00 §4.4)

Shell producers intentionally stay under a few subprocesses per
fire so host tools stay snappy:

| Step | Cost |
| ---- | ---- |
| `jq` parse + envelope build | 1 process |
| ULID mint (`node`) | 1 process |
| atomic write (`python3`) | 1 process |
| optional `cognit inbox --process` | 0 (background, only when `COGNIT_REALTIME=1`) |

Collapsing the ULID mint into the Python atomic-write (dropping one
subprocess) is a tracked polish item, not required for OOB. Phone-home
telemetry is out of scope (local-first).

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
