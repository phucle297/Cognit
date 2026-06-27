# Getting Started

Five minutes from `git clone` to a working Cognit installation.

## 1. Start the local stack

```bash
docker compose up -d
```

Brings up the dashboard + server. The Hono API binds
`127.0.0.1:6971` internally; the Vite dev dashboard is published on
host `http://localhost:5173`. Docker profile publishes on
`http://localhost:6970`. See [`docs/dashboard.md`](dashboard.md) for
the full rule.

## 2. Initialise Cognit inside a project

```bash
cd <your-project>
cognit init
```

Creates `.cognit/` inside the project:

- `.cognit/cognit.yaml` — project config (commit this).
- `.cognit/cognit.db` — the SQLite reasoning graph (gitignored).
- `.cognit/inbox/` — drop folder for hook envelopes.
- `.cognit/artifacts/`, `.cognit/snapshots/`, `.cognit/archive/` —
  runtime state (gitignored).

`init` is idempotent. The Docker `init` service runs it on every
`docker compose up`; re-running against an already-initialised
project prints "already exists; nothing to do" and exits 0.

## 3. Bind a session

```bash
cognit session create "Investigate memory leak"
```

Writes the new session ULID to `.cognit/current-session`. Hooks
read this pointer (or `$COGNIT_SESSION_ID` from
`eval "$(cognit init --shell)"`) to know which session to attribute
their events to.

## 4. Wire the AI tool

Install hooks for your AI tool:

```bash
# Claude Code
install -m 0755 hooks/claude-code/cc-post.sh ~/.cognit/hooks/cc-post.sh
install -m 0755 hooks/claude-code/cc-pre.sh  ~/.cognit/hooks/cc-pre.sh

# Codex
install -m 0755 hooks/codex/codex-post.sh    ~/.cognit/hooks/codex-post.sh

# OpenCode / Gemini CLI — see the provider pages under docs/hooks/.
```

Add the corresponding entries to the host CLI's hooks config
(`~/.claude/settings.json`, `~/.codex/hooks.json`, etc.). Full
wiring lives in [`docs/hooks.md`](hooks.md) and the per-provider
pages ([claude-code](hooks/claude-code.md), [codex](hooks/codex.md),
[opencode](hooks/opencode.md), [gemini-cli](hooks/gemini-cli.md)).

## 5. Use your AI tool normally

```bash
claude
```

The hooks fire on every tool call. Each tool invocation lands as a
v1.2.0 envelope in `.cognit/inbox/`. The watcher (`cognit inbox
--watch`) validates and persists the event; the reasoning graph
folds it into the active session's state.

## 6. Inspect

Open the dashboard (`cognit dashboard`) and navigate:

- `/` — current investigation summary.
- `/timeline` — what just happened.
- `/recovery-center` — what was rejected and why.
- `/knowledge-graph` — entities and their relations.

Lower-level introspection:

```bash
cognit events --follow
cognit session show
cognit recovery search "memory leak"
```

## What's next

- [`docs/cli.md`](cli.md) — every subcommand.
- [`docs/hooks.md`](hooks.md) — how external CLIs publish to Cognit.
- [`docs/architecture.md`](architecture.md) — repo layout, data flow,
  subsystem map.
- [`docs/storage.md`](storage.md) — what lives where on disk.
