# Claude Code Hooks

Claude Code fires hooks on tool lifecycle events. Reference:
`https://code.claude.com/docs/en/hooks`. Settings at
`.claude/settings.json` (project) or `~/.claude/settings.json` (user).

## PostToolUse → observation_recorded

The hook command receives the tool-call JSON on stdin.

```json
{
  "hooks": {
    "PostToolUse": [
      {"matcher": "Edit|Write|Bash", "hooks": [
        {"type": "command", "command": "~/.cognit/hooks/cc-post.sh"}
      ]}
    ]
  }
}
```

`~/.cognit/hooks/cc-post.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
tool=$(jq -r '.tool_name' <<<"$input")
args=$(jq -c '.tool_input' <<<"$input")
session=$(jq -r '.session_id' <<<"$input")
ulid=$(ulid-new)
tmp="$HOME/.cognit/inbox/${session}-${ulid}.json.tmp"
dest="$HOME/.cognit/inbox/${session}-${ulid}.json"
jq -n --arg t "$tool" --argjson a "$args" --arg s "$session" '{
  schema_version:"1.0.0", type:"observation_recorded",
  session_id:$s, actor:{type:"worker",name:"claude-code"},
  source:{tool:"claude-code",command:"PostToolUse"},
  payload:{text:("tool " + $t + " called"), args:$a}
}' > "$tmp"; sync; mv "$tmp" "$dest"
```

## PreToolUse → hypothesis_created

`matcher: "Read|Edit|Write"`. Emit `hypothesis_created` only when the
target file is not in `~/.cognit/known-files.txt` (per `plan.xml:686`).

## Notes

- `matcher` is a regex on `tool_name`. Exit `2` from `PreToolUse` blocks the call.
