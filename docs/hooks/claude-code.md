# Claude Code Hooks

Claude Code fires hooks on tool lifecycle events. Reference:
`https://code.claude.com/docs/en/hooks`. Settings at
`.claude/settings.json` (project) or `~/.claude/settings.json`
(user).

## How it works

```txt
Claude Code
   │
   │ PreToolUse / PostToolUse (stdin = event JSON)
   ▼
cc-pre.sh / cc-post.sh
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
install -m 0755 hooks/claude-code/cc-post.sh ~/.cognit/hooks/cc-post.sh
install -m 0755 hooks/claude-code/cc-pre.sh  ~/.cognit/hooks/cc-pre.sh
```

## Hook

Wire in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {"matcher": "Edit|Write|Bash", "hooks": [
        {"type": "command", "command": "~/.cognit/hooks/cc-post.sh"}
      ]}
    ],
    "PreToolUse": [
      {"matcher": "Read|Edit|Write", "hooks": [
        {"type": "command", "command": "~/.cognit/hooks/cc-pre.sh"}
      ]}
    ]
  }
}
```

`matcher` is a regex on `tool_name`. Exit `2` from `PreToolUse`
blocks the call.

## Flow

| Host event   | Script      | Cognit envelope                          |
|--------------|-------------|------------------------------------------|
| `PreToolUse` | `cc-pre.sh` | `raw_tool_signal` (phase `pre`)          |
| `PostToolUse`| `cc-post.sh`| `raw_tool_signal` (phase `post`)         |

Both scripts follow the **Common behavior** algorithms in
[`docs/hooks/README.md`](./README.md#common-behavior):

- Session id resolution (`$COGNIT_SESSION_ID` →
  `.cognit/current-session` → placeholder).
- Atomic write (open `wx` → write → fsync → close → rename).
- Inbox resolution (`$COGNIT_INBOX` → `./.cognit/inbox/`).

The Claude Code `.session_id` field is intentionally **not** used as
the Cognit session id — see the rationale in the common-behavior
section.

## Payload

Hooks emit evidence-only `raw_tool_signal` (v1.3.0). Semantic
classification into observation/action happens at ingest (Phase 2b),
not in the bash producers.

`raw_tool_signal` payload (PostToolUse, phase `post`):

```json
{
  "phase": "post",
  "host": "claude-code",
  "tool": "Edit",
  "tool_input": {...},
  "tool_response": {...},
  "text": "tool Edit → /tmp/foo.ts",
  "path": "/tmp/foo.ts",
  "command": null
}
```

`raw_tool_signal` payload (PreToolUse, phase `pre`):

```json
{
  "phase": "pre",
  "host": "claude-code",
  "tool": "Edit",
  "tool_input": {...},
  "text": "agent intends to Edit /tmp/foo.ts",
  "path": "/tmp/foo.ts",
  "command": null
}
```

Canonical envelope (v1.3.0 FLAT — see [`docs/technical/events.md`](../technical/events.md)
for the full schema):

```json
{
  "version": "1.3.0",
  "type": "raw_tool_signal",
  "session_id": "01HXY...ULID",
  "actor_name": "claude-code",
  "actor_type": "worker",
  "id": "01JXY...ULID",
  "source": { "tool": "claude-code", "command": "PostToolUse" },
  "payload": { "...": "..." }
}
```

## Source

Producer scripts: [`hooks/claude-code/`](../../hooks/claude-code/).
