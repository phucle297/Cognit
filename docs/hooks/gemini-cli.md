# Gemini CLI Hooks

Gemini CLI hooks are configured in `.gemini/settings.json`. The
vocabulary mirrors Claude Code but uses different event names.
Reference: `https://www.geminicli.com/docs/reference/configuration`.

## How it works

```txt
Gemini CLI
   │
   │ BeforeTool / AfterTool (stdin = event JSON)
   ▼
gemini-pre.sh / gemini-post.sh
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
cp hooks/gemini-cli/gemini-hooks.json ~/.cognit/hooks/gemini-hooks.json
```

The companion shell script (`hooks/gemini-cli/gemini-post.sh`,
Phase G) ships as the AfterTool handler referenced below.

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
| `PreToolUse` | `BeforeTool`                 |
| `PostToolUse`| `AfterTool`                  |
| -            | `BeforeAgent` / `AfterAgent` |
| -            | `SessionStart` / `SessionEnd`|

`BeforeTool` → `hypothesis_created` is the Phase G companion (added
with matcher `"read_file"`, gated by `~/.cognit/known-files.txt`).

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
