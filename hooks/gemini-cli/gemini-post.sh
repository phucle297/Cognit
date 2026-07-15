#!/usr/bin/env bash
#
# gemini-post.sh — Gemini CLI AfterTool hook → Cognit inbox.
#
# Reference producer. Reads the AfterTool JSON payload from stdin,
# builds an envelope v1.2.0 FLAT (actor_name / actor_type) per
# `packages/wrap/src/index.ts:72`, and atomic-writes it to
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

# Session id: COGNIT_SESSION_ID → sticky pointer → mint + stick (see hook-lib.sh).
session="$(cognits_session_id)"

tool="$(jq -r '.tool_name // "unknown"' <<<"$input")"
tool_input="$(jq -c '.tool_input // {}' <<<"$input")"
tool_response="$(jq -c '.tool_response // null' <<<"$input")"

# Mint event ULID (26-char Crockford) via shared helper — never short fallbacks.
event_id="$(cognits_ulid)"

dest="$inbox_dir/${session}-${event_id}.json"

# Build the envelope. `version: "1.2.0"` matches the wrap producer and
# the inbox watcher's EnvelopeSchema literal union. `actor_name` and
# `actor_type` are top-level (FLAT), not nested under `actor:`. The
# `id` field is the per-event ULID; the watcher uses it as the
# primary key in the events table.
payload="$(jq -n \
  --arg     version   "1.2.0" \
  --arg     session   "$session" \
  --arg     type      "observation_recorded" \
  --arg     actorName "gemini-cli" \
  --arg     tool      "$tool" \
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
     source:     {tool: "gemini-cli", command: "AfterTool"},
     payload:    {
       text: ("tool " + $tool + " returned"),
       tool: $tool,
       tool_input: $toolInput,
       tool_response: $toolResp
     }
   }')"

# Atomic write — open(O_CREAT|O_EXCL|O_WRONLY) → write → fsync → close
# → rename. Done in one python process so the fsync is guaranteed to
# land on the same fd the bytes were written to (a shell `printf > tmp
# && python fsync tmp` split can lose the guarantee if the bash-side
# write hasn't flushed to the kernel page cache before the python
# process reopens the file). This mirrors
# `packages/wrap/src/atomic-write.ts::atomicWriteJson` step-for-step.
# Payload is passed via argv (the heredoc body is the python program;
# python ignores stdin in argv-only mode).
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

# Stay quiet on stdout — Gemini CLI captures it but does not display.