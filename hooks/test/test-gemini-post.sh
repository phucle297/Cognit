#!/usr/bin/env bash
#
# test-gemini-post.sh — smoke test for hooks/gemini-cli/gemini-post.sh.
#
# Spins up /tmp/cognit-smoke-gemini with a .cognit/inbox/ tree and
# a .cognit/current-session pointer, pipes a mocked AfterTool JSON
# payload (matching the shape Gemini CLI emits) into gemini-post.sh,
# and asserts the resulting envelope file matches the v1.2.0
# contract for the Gemini producer (AC47):
#
#   - version       = "1.2.0"
#   - actor_name    = "gemini-cli"
#   - source.tool   = "gemini-cli"
#   - source.command = "AfterTool"
#   - id            present (ULID-shaped, non-empty)
#   - file mode     = 0o600
#   - session_id    matches the pre-seeded sticky pointer
#
# Mirrors test-cc-post.sh; the only deltas are the script under test
# and the expected actor/source values.

set -euo pipefail

# Resolve the test directory and the hook-script path absolutely, so
# the relative path survives the later `cd "$SMOKE"` (which would
# otherwise re-interpret the hook path against /tmp and miss).
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${TEST_DIR}/../gemini-cli/gemini-post.sh"

SMOKE="/tmp/cognit-smoke-gemini-post-$$"
INBOX="${SMOKE}/.cognit/inbox"
mkdir -p "$INBOX"
trap 'rm -rf "$SMOKE"' EXIT

SESSION="01H7SESS10NGEM1N1P0ST00001"
printf '%s' "$SESSION" > "${SMOKE}/.cognit/current-session"

input=$(cat <<JSON
{
  "session_id": "gemini-raw-session-do-not-use",
  "tool_name": "write_file",
  "tool_input": {"file_path": "/tmp/gemini.ts", "contents": "x"},
  "tool_response": {"ok": true, "bytes_written": 1}
}
JSON
)

output_file="$(cd "$SMOKE" && env -u COGNIT_MODEL -u ANTHROPIC_MODEL -u CLAUDE_MODEL -u GEMINI_MODEL -u OPENAI_MODEL -u LITELLM_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_SMALL_FAST_MODEL -u CLAUDE_CODE_SUBAGENT_MODEL COGNIT_INBOX="$INBOX" bash "$HOOK" <<<"$input")"

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

# 1. version = 1.2.0
version="$(jq -r '.version' "$envelope")"
if [[ "$version" != "1.2.0" ]]; then
  echo "FAIL: expected version=1.2.0, got version=$version (file: $envelope)" >&2
  exit 1
fi

# 2. actor_name = "gemini-cli"
actor_name="$(jq -r '.actor_name' "$envelope")"
expected_actor="gemini+${SESSION: -6}"
if [[ "$actor_name" != "$expected_actor" ]]; then
  echo "FAIL: expected actor_name=$expected_actor, got actor_name=$actor_name" >&2
  exit 1
fi

# 3. source.tool = "gemini-cli"
source_tool="$(jq -r '.source.tool' "$envelope")"
if [[ "$source_tool" != "gemini-cli" ]]; then
  echo "FAIL: expected source.tool=gemini-cli, got source.tool=$source_tool" >&2
  exit 1
fi

# 4. source.command = "AfterTool"
source_command="$(jq -r '.source.command' "$envelope")"
if [[ "$source_command" != "AfterTool" ]]; then
  echo "FAIL: expected source.command=AfterTool, got source.command=$source_command" >&2
  exit 1
fi

# 5. id present
id="$(jq -r '.id // ""' "$envelope")"
if [[ -z "$id" || "$id" == "null" ]]; then
  echo "FAIL: id field missing or empty" >&2
  exit 1
fi

# 6. file mode = 0o600
mode="$(stat -c '%a' "$envelope" 2>/dev/null || stat -f '%Lp' "$envelope")"
if [[ "$mode" != "600" ]]; then
  echo "FAIL: expected mode 0o600, got 0o$mode" >&2
  exit 1
fi

# 7. session_id matches the pre-seeded sticky pointer
session_id="$(jq -r '.session_id' "$envelope")"
if [[ "$session_id" != "$SESSION" ]]; then
  echo "FAIL: expected session_id=$SESSION, got session_id=$session_id" >&2
  exit 1
fi

echo "PASS: gemini-post.sh emitted valid envelope at $envelope (version=$version, actor_name=$actor_name, source.tool=$source_tool, source.command=$source_command, id=$id, mode=0o$mode)"
exit 0
