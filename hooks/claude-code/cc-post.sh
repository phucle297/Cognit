#!/usr/bin/env bash
#
# cc-post.sh — Claude Code PostToolUse hook → Cognit inbox.
#
# Reference producer. Reads the PostToolUse JSON payload from stdin,
# builds an envelope v1.2.0 FLAT (actor_name / actor_type) per
# `packages/wrap/src/index.ts:72`, and atomic-writes it to
# `<projectRoot>/.cognit/inbox/<session-id>-<event-id>.json` (project-
# relative, with `$COGNIT_INBOX` override) following the protocol from
# `packages/wrap/src/atomic-write.ts` (open(wx) → write → fsync →
# close → rename) — see the python block at the bottom for the exact
# POSIX sequence.
#
# SESSION ID RESOLUTION — order matters:
#   1. `$COGNIT_SESSION_ID` env var (set by `eval "$(cognit env --shell)"`)
#   2. sticky pointer `.cognit/current-session` (written by
#      `cognit session create` / `cognit session resume`)
#   3. placeholder ULID `01HXXX...` so the watcher can still parse
#      the envelope (the `unknown_session_id` sidecar will fire on
#      first run, which is the documented bootstrap flow)
#
# We deliberately do NOT use Claude Code's `.session_id` as the Cognit
# session id — the two namespaces are unrelated, and writing an
# unknown session id into the inbox triggers
# `unknown_session_id` rejection. Bind a Cognit session first via
# `cognit session create`, then start the Claude Code turn.
#
# Wire in `~/.claude/settings.json`:
#
#   {
#     "hooks": {
#       "PostToolUse": [
#         {"matcher": "Edit|Write|Bash", "hooks": [
#           {"type": "command", "command": "~/.cognit/hooks/cc-post.sh"}
#         ]}
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
# atomic-write itself causes a non-zero exit. Claude Code logs the
# stderr text and continues — it does not block the tool call.
set -euo pipefail

# Resolve the inbox dir. `COGNIT_INBOX` overrides the default.
# Cognit is per-project local-first, so the canonical inbox is the
# project-relative `./.cognit/inbox/` (resolved from CWD, where the
# hook command is invoked from the project root by Claude Code).
inbox_dir="${COGNIT_INBOX:-./.cognit/inbox}"
mkdir -p "$inbox_dir"

# Read the full PostToolUse payload from stdin.
input="$(cat)"

# Session id resolution — see header comment for ordering.
session="${COGNIT_SESSION_ID:-}"
if [[ -z "$session" && -f ./.cognit/current-session ]]; then
  session="$(tr -d '[:space:]' < ./.cognit/current-session)"
fi
if [[ -z "$session" ]]; then
  session="01HXXXXXXXXXXXXXXXXXXXXXXXX"
fi

tool="$(jq -r '.tool_name // "unknown"' <<<"$input")"
tool_input="$(jq -c '.tool_input // {}' <<<"$input")"
tool_response="$(jq -c '.tool_response // null' <<<"$input")"

# Mint a fresh ULID via node — same alphabet/length as the `ulid`
# package used by the DB. Keeping generation in a small node one-liner
# avoids pulling in another binary dependency on the host.
event_id="$(node -e 'process.stdout.write(require("ulid")())' \
  2>/dev/null || node -e '
    const t=Date.now();let r="";for(let i=0;i<10;i++)r+=Math.floor(Math.random()*16).toString(16);
    process.stdout.write(t.toString(36).toUpperCase().padStart(10,"0").slice(-10)+r.toUpperCase().slice(0,16));
  ')"

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
  --arg     actorName "claude-code" \
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
     source:     {tool: "claude-code", command: "PostToolUse"},
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

# Stay quiet on stdout — Claude Code captures it but does not display.
