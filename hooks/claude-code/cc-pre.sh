#!/usr/bin/env bash
#
# cc-pre.sh — Claude Code PreToolUse hook → Cognit inbox.
#
# Reference producer. Reads the PreToolUse JSON payload from stdin,
# builds a `hypothesis_created` envelope v1.2.0 FLAT (actor_name /
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
# The `hypothesis_created` envelope carries a `title` and a `text`
# payload per `packages/db/src/event-schema.ts:44`. The `title` is a
# short summary ("Read src/foo.ts"); `text` carries the file path +
# tool intent. The watcher uses these to seed the hypothesis store so
# downstream `hypothesis_weakened` / `hypothesis_rejected` envelopes
# (emitted by the verification engine) can target them by id.
#
# Known-files gate: we only emit when
# the target file is NOT in `~/.cognit/known-files.txt`. That file is
# the bootstrap agent's "already-mapped" allowlist; emitting
# `hypothesis_created` for a file the agent has already classified is
# noise. The gate is best-effort here — a missing allowlist file
# means "emit nothing".
#
# Wire in `~/.claude/settings.json`:
#
#   {
#     "hooks": {
#       "PreToolUse": [
#         {"matcher": "Read|Edit|Write", "hooks": [
#           {"type": "command", "command": "~/.cognit/hooks/cc-pre.sh"}
#         ]}
#       ]
#     }
#   }
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

tool="$(jq -r '.tool_name // "unknown"' <<<"$input")"
file_path="$(jq -r '.tool_input.file_path // .tool_input.path // .tool_input.notebook_path // ""' <<<"$input")"

# Known-files gate. If the file is in the allowlist, do nothing
# (silent exit 0). Claude Code treats exit 0 as "do not block".
if [[ -n "$file_path" && -f "$HOME/.cognit/known-files.txt" ]]; then
  if grep -Fxq "$file_path" "$HOME/.cognit/known-files.txt"; then
    exit 0
  fi
fi

# ULID — see cc-post.sh for the rationale.
event_id="$(node -e 'process.stdout.write(require("ulid")())' \
  2>/dev/null || node -e '
    const t=Date.now();let r="";for(let i=0;i<10;i++)r+=Math.floor(Math.random()*16).toString(16);
    process.stdout.write(t.toString(36).toUpperCase().padStart(10,"0").slice(-10)+r.toUpperCase().slice(0,16));
  ')"

dest="$inbox_dir/${session}-${event_id}.json"

# Build the envelope. `hypothesis_created` requires `title` + `text`
# (both non-empty) per the payload schema. We always have a title
# (the tool name), and `text` carries the file path or a generic
# "tool invoked" message when no path is present.
title="$tool"
if [[ -n "$file_path" ]]; then
  text="agent intends to $tool $file_path"
else
  text="agent intends to invoke $tool"
fi

payload="$(jq -n \
  --arg version   "1.2.0" \
  --arg session   "$session" \
  --arg type      "hypothesis_created" \
  --arg actorName "claude-code" \
  --arg title     "$title" \
  --arg text      "$text" \
  --arg id        "$event_id" \
  '{
     version:    $version,
     type:       $type,
     session_id: $session,
     actor_name: $actorName,
     actor_type: "worker",
     id:         $id,
     source:     {tool: "claude-code", command: "PreToolUse"},
     payload:    {title: $title, text: $text}
   }')"

# Atomic write — open(O_CREAT|O_EXCL|O_WRONLY) → write → fsync → close
# → rename in one python process. Mirrors
# `packages/wrap/src/atomic-write.ts::atomicWriteJson` step-for-step.
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

