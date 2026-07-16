#!/usr/bin/env bash
#
# test-codex-pre.sh — smoke test for hooks/codex/codex-pre.sh.
#
# Spins up /tmp/cognit-smoke-codex with a .cognit/inbox/ tree and
# a .cognit/current-session pointer, pipes a mocked PreToolUse JSON
# payload (matching the shape Codex CLI emits) into codex-pre.sh,
# and asserts the resulting envelope file matches the v1.3.0
# raw_tool_signal contract for the Codex pre-hook producer:
#
#   - type         = "raw_tool_signal"
#   - version      = "1.3.0"
#   - payload.phase = "pre"
#   - payload.tool  = "edit"
#   - text         contains the file path
#   - payload.path  = file path
#   - actor_name   = "codex+..."
#   - id           present
#   - file mode    = 0o600
#
# Also guards the known-files gate by pre-seeding
# $HOME/.cognit/known-files.txt with a *different* file path (the
# target under test must NOT be in the allowlist, so the script
# proceeds to emit).

set -euo pipefail

# Resolve the test directory and the hook-script path absolutely, so
# the relative path survives the later `cd "$SMOKE"` (which would
# otherwise re-interpret the hook path against /tmp and miss).
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${TEST_DIR}/../codex/codex-pre.sh"

SMOKE="/tmp/cognit-smoke-codex-pre-$$"
INBOX="${SMOKE}/.cognit/inbox"
mkdir -p "$INBOX"
trap 'rm -rf "$SMOKE"' EXIT

SESSION="01H7SESS10NC0DEXPRE0000001"
printf '%s' "$SESSION" > "${SMOKE}/.cognit/current-session"

# Stage a known-files allowlist under a temp HOME so the script's
# `~/.cognit/known-files.txt` lookup resolves to an empty-allowlist
# (no overlap with the test file path). We avoid polluting the real
# $HOME.
TEST_HOME="${SMOKE}/home"
mkdir -p "${TEST_HOME}/.cognit"
: > "${TEST_HOME}/.cognit/known-files.txt"

input=$(cat <<JSON
{
  "session_id": "codex-raw-session-do-not-use",
  "tool_name": "edit",
  "tool_input": {"file_path": "/tmp/codex-target.ts", "old_string": "a", "new_string": "b"}
}
JSON
)

# Run the hook with the resolved absolute path. After it exits, list
# the envelope it wrote. `set -o pipefail` ensures the head pipeline
# surfaces a real error if the inbox is empty.
cd "$SMOKE" && env HOME="$TEST_HOME" env -u COGNIT_MODEL -u ANTHROPIC_MODEL -u CLAUDE_MODEL -u GEMINI_MODEL -u OPENAI_MODEL -u LITELLM_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_SMALL_FAST_MODEL -u CLAUDE_CODE_SUBAGENT_MODEL COGNIT_INBOX="$INBOX" bash "$HOOK" <<<"$input"
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

# 1. type = "raw_tool_signal"
type="$(jq -r '.type' "$envelope")"
if [[ "$type" != "raw_tool_signal" ]]; then
  echo "FAIL: expected type=raw_tool_signal, got type=$type (file: $envelope)" >&2
  exit 1
fi

# 2. payload.tool = edit
tool="$(jq -r '.payload.tool' "$envelope")"
if [[ "$tool" != "edit" ]]; then
  echo "FAIL: expected payload.tool=edit, got payload.tool=$tool" >&2
  exit 1
fi

# 3. phase = pre
phase="$(jq -r '.payload.phase' "$envelope")"
if [[ "$phase" != "pre" ]]; then
  echo "FAIL: expected payload.phase=pre, got payload.phase=$phase" >&2
  exit 1
fi

# 4. text contains the file path
text="$(jq -r '.payload.text' "$envelope")"
if [[ "$text" != *"/tmp/codex-target.ts"* ]]; then
  echo "FAIL: expected payload.text to contain '/tmp/codex-target.ts', got payload.text=$text" >&2
  exit 1
fi

# 5. path field set
path="$(jq -r '.payload.path // ""' "$envelope")"
if [[ "$path" != "/tmp/codex-target.ts" ]]; then
  echo "FAIL: expected payload.path=/tmp/codex-target.ts, got path=$path" >&2
  exit 1
fi

# 6. version = 1.3.0
version="$(jq -r '.version' "$envelope")"
if [[ "$version" != "1.3.0" ]]; then
  echo "FAIL: expected version=1.3.0, got version=$version" >&2
  exit 1
fi

# 7. actor_name = <model>+<hash> (default family codex when no MODEL env)
actor_name="$(jq -r '.actor_name' "$envelope")"
expected_actor="codex+${SESSION: -6}"
if [[ "$actor_name" != "$expected_actor" ]]; then
  echo "FAIL: expected actor_name=$expected_actor, got actor_name=$actor_name" >&2
  exit 1
fi

# 8. id present
id="$(jq -r '.id // ""' "$envelope")"
if [[ -z "$id" || "$id" == "null" ]]; then
  echo "FAIL: id field missing or empty" >&2
  exit 1
fi

# 9. file mode = 0o600
mode="$(stat -c '%a' "$envelope" 2>/dev/null || stat -f '%Lp' "$envelope")"
if [[ "$mode" != "600" ]]; then
  echo "FAIL: expected mode 0o600, got 0o$mode" >&2
  exit 1
fi

echo "PASS: codex-pre.sh emitted valid envelope at $envelope (type=$type, phase=$phase, tool=$tool, text=$text, version=$version, actor_name=$actor_name, id=$id, mode=0o$mode)"
exit 0
