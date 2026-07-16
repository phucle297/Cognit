# Codex Hooks

Codex CLI reads hooks from `<repo>/.codex/hooks.json` or
`config.toml [hooks]` blocks. Reference:
`https://developers.openai.com/codex/config-advanced`.

## How it works

```txt
Codex CLI
   │
   │ PreToolUse / PostToolUse (stdin = event JSON)
   ▼
codex-pre.sh / codex-post.sh
   │
   │ atomic write (write → fsync → rename)
   ▼
.cognit/inbox/<session>-<ulid>.json
   │
   │ validate + persist + fold state (lazy drain on next read command,
   │ or `cognit inbox --watch` / `--process` / `--reprocess`)
   ▼
cognit continue   →   SQLite   →   dashboard
```

## Install

```bash
mkdir -p ~/.cognit/hooks
install -m 0755 hooks/codex/codex-pre.sh  ~/.cognit/hooks/codex-pre.sh
install -m 0755 hooks/codex/codex-post.sh ~/.cognit/hooks/codex-post.sh
```

## Hook

Wire in `~/.codex/hooks.json` (user layer):

```json
{
  "hooks": {
    "PostToolUse": [
      {"matcher": ".*", "type": "command",
       "command": "~/.cognit/hooks/codex-post.sh", "timeout": 30}
    ]
  }
}
```

TOML equivalent uses `[[hooks.PostToolUse]]` +
`[[hooks.PostToolUse.hooks]]` with the same `matcher` / `type` /
`command` / `timeout` fields. One form per layer — Codex warns if
both are present.

## Flow

| Host event   | Script         | Cognit envelope                  |
|--------------|----------------|----------------------------------|
| `PreToolUse` | `codex-pre.sh` | `raw_tool_signal` (phase `pre`)  |
| `PostToolUse`| `codex-post.sh`| `raw_tool_signal` (phase `post`) |

Follows the **Common behavior** algorithms in
[`docs/hooks/README.md`](./README.md#common-behavior). Identical to
the Claude Code path except for `actor_name` / `source.tool` /
`payload.host` (`"codex"`).

## Payload

Hooks emit evidence-only `raw_tool_signal` (v1.3.0). Classification
is deferred to ingest Phase 2b.

`raw_tool_signal` payload (PostToolUse):

```json
{
  "phase": "post",
  "host": "codex",
  "tool": "<tool_name>",
  "tool_input": {...},
  "tool_response": {...},
  "text": "tool <tool_name> returned",
  "path": null,
  "command": null
}
```

Canonical envelope (v1.3.0 FLAT — see [`docs/technical/events.md`](../technical/events.md)):

```json
{
  "version": "1.3.0",
  "type": "raw_tool_signal",
  "session_id": "01HXY...ULID",
  "actor_name": "codex",
  "actor_type": "worker",
  "id": "01JXY...ULID",
  "source": { "tool": "codex", "command": "PostToolUse" },
  "payload": { "...": "..." }
}
```

## Source

Producer script: [`hooks/codex/`](../../hooks/codex/).
