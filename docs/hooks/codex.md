# Codex Hooks

Codex CLI reads hooks from `<repo>/.codex/hooks.json` or
`config.toml [hooks]` blocks (equivalent; pick one per layer).
Reference: `https://developers.openai.com/codex/config-advanced`.

Project hooks load only when the project layer is trusted. User hooks
live at `~/.codex/hooks.json`. Codex uses the same event names as
Claude Code (`PreToolUse`, `PostToolUse`); the hook command receives
the event JSON on stdin.

## Shape (hooks.json)

```json
{
  "hooks": {
    "PreToolUse": [{"matcher": "^Bash$", "type": "command",
       "command": "~/.cognit/hooks/codex-pre.sh", "timeout": 30}],
    "PostToolUse": [{"matcher": ".*", "type": "command",
       "command": "~/.cognit/hooks/codex-post.sh", "timeout": 30}]
  }
}
```

TOML equivalent uses `[[hooks.PreToolUse]]` + `[[hooks.PreToolUse.hooks]]`
with the same `matcher`/`type`/`command`/`timeout` fields.

## Producer script

Read stdin JSON, build an envelope with `schema_version: "1.0.0"`,
write to `<inbox>/<session>-<ulid>.json.tmp`, `sync`, rename to `.json`.

```bash
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
session=$(jq -r '.session_id // "01HXXXXXXXXXXXXXXXXXXXXXXXX"' <<<"$input")
ulid=$(ulid-new)
tmp="$HOME/.cognit/inbox/${session}-${ulid}.json.tmp"
dest="$HOME/.cognit/inbox/${session}-${ulid}.json"
jq -n --arg s "$session" --argjson i "$input" \
  '{schema_version:"1.0.0", type:"observation_recorded",
   session_id:$s, actor:{type:"worker",name:"codex"},
   payload:{text:"codex tool event", raw:$i}}' \
  > "$tmp"; sync; mv "$tmp" "$dest"
```

## Notes

- One form per layer — Codex warns if both are present.
