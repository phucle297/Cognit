# Gemini CLI Hooks

Gemini CLI hooks are configured in `.gemini/settings.json`. The
vocabulary mirrors Claude Code but uses different event names.
Reference: `https://www.geminicli.com/docs/reference/configuration`.

## Event names

| Claude Code  | Gemini CLI                   |
|--------------|------------------------------|
| `PreToolUse` | `BeforeTool`                 |
| `PostToolUse`| `AfterTool`                  |
| -            | `BeforeAgent` / `AfterAgent` |
| -            | `SessionStart` / `SessionEnd`|

## AfterTool → observation_recorded

```json
{
  "hooksConfig": {"enabled": true, "disabled": [], "notifications": true},
  "hooks": {"AfterTool": [
    {"matcher": "*", "type": "shell", "command": "~/.cognit/hooks/gemini-post.sh"}
  ]}
}
```

`~/.cognit/hooks/gemini-post.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
tool=$(jq -r '.toolName // .name' <<<"$input")
args=$(jq -c '.args // .arguments' <<<"$input")
session=$(jq -r '.session_id // "01HXXXXXXXXXXXXXXXXXXXXXXXX"' <<<"$input")
ulid=$(ulid-new)
tmp="$HOME/.cognit/inbox/${session}-${ulid}.json.tmp"
dest="$HOME/.cognit/inbox/${session}-${ulid}.json"
jq -n --arg t "$tool" --argjson a "$args" --arg s "$session" '{
  schema_version:"1.0.0", type:"observation_recorded",
  session_id:$s, actor:{type:"worker",name:"gemini-cli"},
  source:{tool:"gemini-cli",command:"AfterTool"},
  payload:{text:("tool " + $t + " returned"), args:$a}
}' > "$tmp"; sync; mv "$tmp" "$dest"
```

## BeforeTool → hypothesis_created

Add a `BeforeTool` block with matcher `"read_file"`, emit
`hypothesis_created` when the path is not in `~/.cognit/known-files.txt`.
