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
# SESSION ID RESOLUTION — order matters (see hook-lib.sh):
#   1. `$COGNIT_SESSION_ID` env var (set by `eval "$(cognit env --shell)"`)
#   2. sticky pointer `.cognit/current-session` (valid 26-char ULID)
#   3. mint a new ULID, write sticky pointer, use it for this + later hooks
# Session DB row is lazy-created on drain (`cognit continue` / inbox process).
#
# Event ids are always 26-char Crockford ULIDs from `ulid.mjs` — short
# hex/base36 fallbacks are forbidden (they reject as bad filenames).
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

# Shared ULID + sticky session.
# Installed layout: ~/.cognit/hooks/{hook-lib.sh,ulid.mjs,cc-post.sh}
# Dev layout:       hooks/<tool>/*.sh + hooks/shared/{hook-lib.sh,ulid.mjs}
_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
if [[ -f "${_HOOK_DIR}/hook-lib.sh" ]]; then
  source "${_HOOK_DIR}/hook-lib.sh"
elif [[ -f "${_HOOK_DIR}/../shared/hook-lib.sh" ]]; then
  source "${_HOOK_DIR}/../shared/hook-lib.sh"
  # Point helper lookups at shared/ for ulid.mjs
  _HOOK_DIR="$(cd "${_HOOK_DIR}/../shared" && pwd)"
else
  echo "cognit hook: missing hook-lib.sh (re-run cognit init to reinstall hooks)" >&2
  exit 1
fi

# Cognit is per-project local-first; canonical inbox is
# `./.cognit/inbox/` (project-relative). `COGNIT_INBOX` overrides.
inbox_dir="${COGNIT_INBOX:-./.cognit/inbox}"
mkdir -p "$inbox_dir"

input="$(cat)"

# Session id: COGNIT_SESSION_ID → sticky pointer → mint + stick (see hook-lib.sh).
session="$(cognits_session_id)"

tool="$(jq -r '.tool_name // .name // "unknown"' <<<"$input")"
tool_input="$(jq -c '.tool_input // .arguments // {}' <<<"$input")"

# Mint event ULID (26-char Crockford) via shared helper — never short fallbacks.
event_id="$(cognits_ulid)"

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

