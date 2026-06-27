#!/usr/bin/env bash
#
# test-cc-post.sh — smoke test for hooks/claude-code/cc-post.sh.
#
# Spins up /tmp/cognit-smoke with a .cognit/inbox/ tree and a
# .cognit/current-session pointer, pipes a mocked PostToolUse JSON
# payload into cc-post.sh, and asserts the resulting envelope file
# matches the v1.2.0 contract:
#
#   - version     = "1.2.0"
#   - actor_name  = "claude-code"
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
SESSION="01HSESSIONCCPOST000000000"
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
output_file="$(cd "$SMOKE" && env COGNIT_INBOX="$INBOX" bash "$HOOK" <<<"$input")"

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

# 1. version = 1.2.0
version="$(jq -r '.version' "$envelope")"
if [[ "$version" != "1.2.0" ]]; then
  echo "FAIL: expected version=1.2.0, got version=$version (file: $envelope)" >&2
  exit 1
fi

# 2. actor_name = "claude-code"
actor_name="$(jq -r '.actor_name' "$envelope")"
if [[ "$actor_name" != "claude-code" ]]; then
  echo "FAIL: expected actor_name=claude-code, got actor_name=$actor_name" >&2
  exit 1
fi

# 3. id present and non-empty
id="$(jq -r '.id // ""' "$envelope")"
if [[ -z "$id" || "$id" == "null" ]]; then
  echo "FAIL: id field missing or empty" >&2
  exit 1
fi

# 4. file mode = 0o600
mode="$(stat -c '%a' "$envelope" 2>/dev/null || stat -f '%Lp' "$envelope")"
if [[ "$mode" != "600" ]]; then
  echo "FAIL: expected mode 0o600, got 0o$mode" >&2
  exit 1
fi

# 5. session_id matches our pre-seeded sticky pointer (regression
#    for "we don't trust the agent's session id").
session_id="$(jq -r '.session_id' "$envelope")"
if [[ "$session_id" != "$SESSION" ]]; then
  echo "FAIL: expected session_id=$SESSION, got session_id=$session_id" >&2
  exit 1
fi

echo "PASS: cc-post.sh emitted valid envelope at $envelope (version=$version, actor_name=$actor_name, id=$id, mode=0o$mode)"
exit 0
