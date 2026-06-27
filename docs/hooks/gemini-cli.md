# Gemini CLI Hooks

Gemini CLI hooks are configured in `.gemini/settings.json`. The
vocabulary mirrors Claude Code but uses different event names.
Reference: `https://www.geminicli.com/docs/reference/configuration`.

## How it works

```txt
Gemini CLI
   │
   │ AfterTool (stdin = event JSON)
   ▼
gemini-post.sh
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
install -m 0755 hooks/gemini-cli/gemini-post.sh ~/.cognit/hooks/gemini-post.sh
cp hooks/gemini-cli/gemini-hooks.json ~/.cognit/hooks/gemini-hooks.json
```

## Hook

Drop under `~/.gemini/settings.json` (user layer) or
`.gemini/settings.json` (project layer):

```json
{
  "hooksConfig": {"enabled": true, "disabled": [], "notifications": true},
  "hooks": {
    "AfterTool": [
      {"matcher": "*", "type": "shell", "command": "~/.cognit/hooks/gemini-post.sh"}
    ]
  }
}
```

| Claude Code  | Gemini CLI                   |
|--------------|------------------------------|
| `PreToolUse` | (not shipped)                |
| `PostToolUse`| `AfterTool`                  |
| -            | `BeforeAgent` / `AfterAgent` |
| -            | `SessionStart` / `SessionEnd`|

> Gemini ships only an `AfterTool` producer. The pre-tool
> `hypothesis_created` path used by Claude / Codex is not yet wired
> — when added it will live at `hooks/gemini-cli/gemini-pre.sh` and
> be installed the same way.

## Flow

| Host event   | Script           | Cognit envelope       |
|--------------|------------------|------------------------|
| `AfterTool`  | `gemini-post.sh` | `observation_recorded` |

Follows the **Common behavior** algorithms in
[`docs/hooks/README.md`](./README.md#common-behavior). Identical to
the Claude Code / Codex PostToolUse path except for `actor_name`
(`"gemini-cli"`) and `source.tool` (`"gemini-cli"`).

## Payload

`observation_recorded` payload (AfterTool):

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
  "actor_name": "gemini-cli",
  "actor_type": "worker",
  "id": "01JXY...ULID",
  "source": { "tool": "gemini-cli", "command": "AfterTool" },
  "payload": { "...": "..." }
}
```

## Source

Hooks config + producer scripts:
[`hooks/gemini-cli/`](../../hooks/gemini-cli/).
