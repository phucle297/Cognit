#!/usr/bin/env bash
#
# codex-post.sh — Codex CLI PostToolUse hook → Cognit inbox.
#
# Reference producer. Reads the PostToolUse JSON payload from stdin,
# builds an `observation_recorded` envelope v1.2.0 FLAT (actor_name /
# actor_type) per `packages/wrap/src/index.ts:72`, and atomic-writes
# it to `<projectRoot>/.cognit/inbox/<session-id>-<event-id>.json`
# (project-relative, with `$COGNIT_INBOX` override) following the
# protocol from `packages/wrap/src/atomic-write.ts` (open(wx) → write
# → fsync → close → rename) — see the python block at the bottom.
#
# SESSION ID RESOLUTION — order matters:
#   1. `$COGNIT_SESSION_ID` env var (set by `eval "$(cognit env --shell)"`)
#   2. sticky pointer `.cognit/current-session` (written by
#      `cognit session create` / `cognit session resume`)
#   3. placeholder ULID `01HXXX...` so the watcher can still parse
#      the envelope (the `unknown_session_id` sidecar will fire on
#      first run, which is the documented bootstrap flow)
#
# Codex emits the same event vocabulary as Claude Code
# (`PreToolUse` / `PostToolUse`) — see `docs/hooks/codex.md`. The
# payload shape is identical, so this script mirrors `cc-post.sh`
# 1:1 except for `actor_name` ("codex" instead of "claude-code")
# and `source.tool`.
#
# Wire in `~/.codex/hooks.json` (user layer):
#
#   {
#     "hooks": {
#       "PostToolUse": [
#         {"matcher": ".*", "type": "command",
#          "command": "~/.cognit/hooks/codex-post.sh", "timeout": 30}
#       ]
#     }
#   }
#
# Or TOML equivalent (config.toml `[hooks]` blocks).
#
# Requirements: `jq`, `node`, `python3` (same as cc-post.sh).
set -euo pipefail

# Cognit is per-project local-first; canonical inbox is
# `./.cognit/inbox/` (project-relative). `COGNIT_INBOX` overrides.
inbox_dir="${COGNIT_INBOX:-./.cognit/inbox}"
mkdir -p "$inbox_dir"

input="$(cat)"

# Session id resolution — same order as cc-post.sh.
session="${COGNIT_SESSION_ID:-}"
if [[ -z "$session" && -f ./.cognit/current-session ]]; then
  session="$(tr -d '[:space:]' < ./.cognit/current-session)"
fi
if [[ -z "$session" ]]; then
  session="01HXXXXXXXXXXXXXXXXXXXXXXX"
fi

tool="$(jq -r '.tool_name // .name // "unknown"' <<<"$input")"
tool_input="$(jq -c '.tool_input // .arguments // {}' <<<"$input")"

# ULID — same approach as cc-post.sh.
event_id="$(node -e 'process.stdout.write(require("ulid")())' \
  2>/dev/null || node -e '
    const t=Date.now();let r="";for(let i=0;i<10;i++)r+=Math.floor(Math.random()*16).toString(16);
    process.stdout.write(t.toString(36).toUpperCase().padStart(10,"0").slice(-10)+r.toUpperCase().slice(0,16));
  ')"

dest="$inbox_dir/${session}-${event_id}.json"

payload="$(jq -n \
  --arg     version "1.2.0" \
  --arg     session "$session" \
  --arg     type    "observation_recorded" \
  --arg     actor   "codex" \
  --arg     tool    "$tool" \
  --argjson args   "$tool_input" \
  --arg     id      "$event_id" \
  '{
     version:    $version,
     type:       $type,
     session_id: $session,
     actor_name: $actor,
     actor_type: "worker",
     id:         $id,
     source:     {tool: "codex", command: "PostToolUse"},
     payload:    {
       text: ("tool " + $tool + " returned"),
       tool: $tool,
       tool_input: $args
     }
   }')"

# Atomic write — see cc-post.sh for the rationale. Mirrors
# `packages/wrap/src/atomic-write.ts::atomicWriteJson`.
python3 - "$dest" "$payload" <<'PY'
import os, sys
path, payload = sys.argv[1], sys.argv[2]
tmp = path + ".tmp"
fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
try:
    os.write(fd, payload.encode("utf-8"))
    os.fsync(fd)
finally:
    os.close(fd)
os.rename(tmp, path)
PY

# D-M4-00 §4.1: near-realtime without a daemon. When
# `inbox.realtime: true`, `cognit env --shell` exports
# COGNIT_REALTIME=1; fire-and-forget a one-shot drain so SQLite sees
# the event without waiting for the next read command. Never block
# the host CLI; never fail the hook if cognit is missing.
if [[ "${COGNIT_REALTIME:-0}" == "1" ]] && command -v cognit >/dev/null 2>&1; then
  (cognit inbox --process >/dev/null 2>&1 &) || true
fi

