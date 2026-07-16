# Grok Build hooks → Cognit

Grok Build discovers hooks from:

| Scope | Path |
|-------|------|
| Global | `~/.grok/hooks/*.json` |
| Global (Claude compat) | `~/.claude/settings.json` |
| Project | `<project>/.grok/hooks/*.json` |

`cognit init` wires **both**:

1. Claude-compatible entries in `~/.claude/settings.json` (Grok scans them by default).
2. A dedicated file `~/.grok/hooks/cognit.json` so Cognit works even when Claude compat is disabled.

## Install

```bash
cognit init   # detects ~/.grok and installs producers + wiring
```

Producers live at `~/.cognit/hooks/cc-post.sh` / `cc-pre.sh` (shared with Claude Code). They are **CLI-agnostic**: host is detected from `GROK_*` env and camelCase stdin (`toolName` / `toolInput` / `toolResult`).

## Payload shape (stdin)

Grok sends camelCase JSON, for example:

```json
{
  "hookEventName": "post_tool_use",
  "toolName": "search_replace",
  "toolInput": { "file_path": "src/app.ts", "old_string": "a", "new_string": "b" },
  "toolResult": { "ok": true },
  "toolUseId": "call-…",
  "transcriptPath": "/home/…/.grok/sessions/…/updates.jsonl",
  "cwd": "/path/to/project"
}
```

Matchers in Claude-style settings alias Claude tool names onto Grok tools (`Edit`→`search_replace`, `Bash`→`run_terminal_command`, …). Cognit’s Grok wiring uses matcher `.*` to capture all tools.

## Envelope `source`

| Field | Value when running under Grok |
|-------|-------------------------------|
| `source.tool` | `grok` |
| `source.command` | `PostToolUse` / `PreToolUse` (normalized) |

Actor family defaults to `grok` then resolves to `<model>+<sessionHash6>` when a model is detectable from env/transcript.

## Drain hooks (Stop / SessionEnd)

`cognit init` also wires `~/.cognit/hooks/cc-drain.sh` on `Stop` and
`SessionEnd`. That script only flushes the inbox → SQLite (no new
observation). Combined with per-tool `cognits_maybe_drain` in
`cc-pre.sh` / `cc-post.sh`, Grok sessions populate the dashboard
without `cognit inbox --process`.

Opt out: `inbox.realtime: false` in `.cognit/cognit.yaml`.
