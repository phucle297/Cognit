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
   │ validate + persist + fold state
   ▼
cognit inbox --watch   →   SQLite   →   dashboard
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

| Host event   | Script         | Cognit envelope       |
|--------------|----------------|------------------------|
| `PostToolUse`| `codex-post.sh`| `observation_recorded` |

Follows the **Common behavior** algorithms in
[`docs/hooks/README.md`](./README.md#common-behavior). Identical to
the Claude Code PostToolUse path except for `actor_name` (`"codex"`)
and `source.tool` (`"codex"`).

## Payload

`observation_recorded` payload (PostToolUse):

```json
{
  "text": "tool <tool_name> returned",
  "tool": "<tool_name>",
  "tool_input": {...}
}
```

Canonical envelope (v1.2.0 FLAT — see [`docs/events.md`](../events.md)):

```json
{
  "version": "1.2.0",
  "type": "observation_recorded",
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
