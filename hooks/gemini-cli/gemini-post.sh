#!/usr/bin/env bash
#
# gemini-post.sh — Gemini CLI AfterTool hook → Cognit inbox.
#
# Reference producer. Reads the AfterTool JSON payload from stdin,
# builds a `raw_tool_signal` envelope v1.3.0 FLAT (actor_name /
# actor_type) per `packages/db/src/event-schema.ts` RawToolSignalPayload,
# and atomic-writes it to
# `<projectRoot>/.cognit/inbox/<session-id>-<event-id>.json` (project-
# relative, with `$COGNIT_INBOX` override) following the protocol from
# `packages/wrap/src/atomic-write.ts` (open(wx) → write → fsync →
# close → rename) — see the python block at the bottom for the exact
# POSIX sequence.
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
# Wire in `~/.gemini/settings.json` (user layer) or
# `.gemini/settings.json` (project layer):
#
#   {
#     "hooksConfig": {"enabled": true, "disabled": [], "notifications": true},
#     "hooks": {
#       "AfterTool": [
#         {"matcher": "*", "type": "shell", "command": "~/.cognit/hooks/gemini-post.sh"}
#       ]
#     }
#   }
#
# Requirements on the host:
#   - `jq`        for stdin parsing
#   - `node`      for ULID generation (Crockford base32, 26 chars)
#   - `python3`   for portable atomic write + fsync + rename
#
# Failure policy: any error from stdin parse, ULID mint, or the
# atomic-write itself causes a non-zero exit. Gemini CLI logs the
# stderr text and continues — it does not block the tool call.
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

# Resolve the inbox dir. `COGNIT_INBOX` overrides the default.
# Cognit is per-project local-first, so the canonical inbox is the
# project-relative `./.cognit/inbox/` (resolved from CWD, where the
# hook command is invoked from the project root by Gemini CLI).
inbox_dir="${COGNIT_INBOX:-./.cognit/inbox}"
mkdir -p "$inbox_dir"

# Read the full AfterTool payload from stdin.
input="$(cat)"
cognits_hook_debug_dump "$input"

# Session id: COGNIT_SESSION_ID → sticky pointer → mint + stick (see hook-lib.sh).
session="$(cognits_session_id)"
# Detect host CLI (claude-code | codex | grok | …) for source labeling.
host_info="$(cognits_detect_host "$input" "gemini-cli")"
host_id="${host_info%%|*}"
host_event="${host_info#*|}"
[[ -z "$host_event" || "$host_event" == "$host_info" ]] && host_event="AfterTool"
actor_default="$(cognits_host_actor_default "$host_id")"
actor_name="$(cognits_actor_name "$session" "$actor_default" "$input")"

# Multi-path tool parse (Claude snake_case + Grok camelCase + peers).
fields="$(cognits_tool_fields_json "$input" "post")"
tool="$(jq -r '.tool // "unknown"' <<<"$fields")"
tool_input="$(jq -c '.tool_input // {}' <<<"$fields")"
tool_response="$(jq -c '.tool_response // null' <<<"$fields")"
file_path="$(jq -r '.file_path // ""' <<<"$fields")"
command="$(jq -r '.command // ""' <<<"$fields")"
text="$(jq -r '.text // ("tool " + .tool + " returned")' <<<"$fields")"

# Mint event ULID (26-char Crockford) via shared helper — never short fallbacks.
event_id="$(cognits_ulid)"

dest="$inbox_dir/${session}-${event_id}.json"

# Build the envelope. `raw_tool_signal` v1.3.0 FLAT; evidence only.
payload="$(jq -n \
  --arg     version   "1.3.0" \
  --arg     session   "$session" \
  --arg     type      "raw_tool_signal" \
  --arg     actorName "$actor_name" \
  --arg     hostId    "$host_id" \
  --arg     hostEvent "$host_event" \
  --arg     phase     "post" \
  --arg     tool      "$tool" \
  --arg     text      "$text" \
  --arg     path      "$file_path" \
  --arg     cmd       "$command" \
  --argjson toolInput "$tool_input" \
  --argjson toolResp  "$tool_response" \
  --arg     id        "$event_id" \
  '{
     version:    $version,
     type:       $type,
     session_id: $session,
     actor_name: $actorName,
     actor_type: "worker",
     id:         $id,
     source:     {tool: $hostId, command: $hostEvent},
     payload:    {
       phase: $phase,
       host: $hostId,
       tool: $tool,
       tool_input: $toolInput,
       tool_response: $toolResp,
       text: $text,
       path: (if $path == "" then null else $path end),
       command: (if $cmd == "" then null else $cmd end)
     }
   }')"

cognits_atomic_write_json "$dest" "$payload"

# Agent OOB drain: fire-and-forget inbox → SQLite (default ON).
# Self-resolves inbox.realtime / COGNIT_REALTIME; debounced. See hook-lib.sh.
cognits_maybe_drain || true

# Stay quiet on stdout — Gemini CLI captures it but does not display.
