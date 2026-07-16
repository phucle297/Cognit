#!/usr/bin/env bash
#
# test-cc-post.sh — smoke test for hooks/claude-code/cc-post.sh.
#
# Spins up /tmp/cognit-smoke with a .cognit/inbox/ tree and a
# .cognit/current-session pointer, pipes a mocked PostToolUse JSON
# payload into cc-post.sh, and asserts the resulting envelope file
# matches the v1.3.0 raw_tool_signal contract:
#
#   - version     = "1.3.0"
#   - type        = "raw_tool_signal"
#   - payload.phase = "post"
#   - payload.host  = "claude-code"
#   - actor_name  = "claude+..."
#   - id          present (ULID-shaped, non-empty)
#   - file mode   = 0o600
#
# Mirrors the manual-smoke pattern from prior phases; reusable as
# the AC39 verification step.

set -euo pipefail

# Resolve the test directory and the hook-script path absolutely, so
# the relative path survives the later `cd "$SMOKE"` (which would
# otherwise re-interpret the hook path against /tmp and miss).
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${TEST_DIR}/../claude-code/cc-post.sh"

SMOKE="/tmp/cognit-smoke-cc-post-$$"
INBOX="${SMOKE}/.cognit/inbox"
mkdir -p "$INBOX"
trap 'rm -rf "$SMOKE"' EXIT

# Pre-seed a sticky session id so the script does NOT fall back to
# the placeholder ULID (that path is exercised elsewhere; here we
# want a stable session_id on the envelope).
SESSION="01H7SESS10NCCPXST000000001"
printf '%s' "$SESSION" > "${SMOKE}/.cognit/current-session"

input=$(cat <<JSON
{
  "session_id": "claude-code-raw-session-do-not-use",
  "tool_name": "Edit",
  "tool_input": {"file_path": "/tmp/example.ts", "old_string": "a", "new_string": "b"},
  "tool_response": {"success": true, "duration_ms": 42}
}
JSON
)

# Run from the smoke root so the project-relative ./cognit paths resolve.
output_file="$(cd "$SMOKE" && env -u COGNIT_MODEL -u ANTHROPIC_MODEL -u CLAUDE_MODEL -u GEMINI_MODEL -u OPENAI_MODEL -u LITELLM_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_SMALL_FAST_MODEL -u CLAUDE_CODE_SUBAGENT_MODEL COGNIT_INBOX="$INBOX" bash "$HOOK" <<<"$input")"

# The script emits to stdout nothing (we pipe it anyway to keep the
# shell happy). Find the envelope file written to $INBOX.
envelope="$(ls "$INBOX"/*.json 2>/dev/null | head -n 1)"
if [[ -z "$envelope" || ! -f "$envelope" ]]; then
  echo "FAIL: no envelope file written to $INBOX" >&2
  ls -la "$INBOX" >&2 || true
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required for content verification" >&2
  exit 1
fi

# 1. version = 1.3.0
version="$(jq -r '.version' "$envelope")"
if [[ "$version" != "1.3.0" ]]; then
  echo "FAIL: expected version=1.3.0, got version=$version (file: $envelope)" >&2
  exit 1
fi

# 2. type = raw_tool_signal
type="$(jq -r '.type' "$envelope")"
if [[ "$type" != "raw_tool_signal" ]]; then
  echo "FAIL: expected type=raw_tool_signal, got type=$type" >&2
  exit 1
fi

# 3. actor_name = <model>+<session-hash6> (default model family "claude")
actor_name="$(jq -r '.actor_name' "$envelope")"
expected_actor="claude+${SESSION: -6}"
if [[ "$actor_name" != "$expected_actor" ]]; then
  echo "FAIL: expected actor_name=$expected_actor, got actor_name=$actor_name" >&2
  exit 1
fi

# 4. id present and non-empty
id="$(jq -r '.id // ""' "$envelope")"
if [[ -z "$id" || "$id" == "null" ]]; then
  echo "FAIL: id field missing or empty" >&2
  exit 1
fi

# 5. file mode = 0o600
mode="$(stat -c '%a' "$envelope" 2>/dev/null || stat -f '%Lp' "$envelope")"
if [[ "$mode" != "600" ]]; then
  echo "FAIL: expected mode 0o600, got 0o$mode" >&2
  exit 1
fi

# 6. session_id matches our pre-seeded sticky pointer (regression
#    for "we don't trust the agent's session id").
session_id="$(jq -r '.session_id' "$envelope")"
if [[ "$session_id" != "$SESSION" ]]; then
  echo "FAIL: expected session_id=$SESSION, got session_id=$session_id" >&2
  exit 1
fi

# 7. payload phase / host / tool
phase="$(jq -r '.payload.phase // ""' "$envelope")"
if [[ "$phase" != "post" ]]; then
  echo "FAIL: expected payload.phase=post, got phase=$phase" >&2
  exit 1
fi
host="$(jq -r '.payload.host // ""' "$envelope")"
if [[ "$host" != "claude-code" ]]; then
  echo "FAIL: expected payload.host=claude-code, got host=$host" >&2
  exit 1
fi
tool="$(jq -r '.payload.tool // ""' "$envelope")"
if [[ "$tool" != "Edit" ]]; then
  echo "FAIL: expected payload.tool=Edit, got tool=$tool" >&2
  exit 1
fi

# 8. path from tool_input.file_path
path="$(jq -r '.payload.path // ""' "$envelope")"
if [[ "$path" != "/tmp/example.ts" ]]; then
  echo "FAIL: expected payload.path=/tmp/example.ts, got path=$path" >&2
  exit 1
fi

# 9. summary text mentions tool / path
ptext="$(jq -r '.payload.text // ""' "$envelope")"
if [[ "$ptext" != *Edit* ]]; then
  echo "FAIL: expected payload.text to mention Edit, got text=$ptext" >&2
  exit 1
fi

echo "PASS: cc-post.sh emitted valid envelope at $envelope (version=$version, type=$type, phase=$phase, actor_name=$actor_name, id=$id, mode=0o$mode)"
exit 0
