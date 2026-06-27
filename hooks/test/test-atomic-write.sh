#!/usr/bin/env bash
#
# test-atomic-write.sh — exercises the python atomic-write primitive
# used by every hook producer in this tree (cc-post.sh, cc-pre.sh,
# codex-post.sh, codex-pre.sh, gemini-post.sh). The primitive is the
# `python3 - "$dest" "$payload" <<'PY' ...` block at the bottom of
# each script; this test runs the same block in isolation against a
# scratch directory under /tmp/cognit-smoke.
#
# Asserts (AC38):
#   1. The destination file exists after the call.
#   2. File mode is 0o600.
#   3. No `.tmp` sibling is left behind (the rename must complete).
#   4. JSON content parses as a valid v1.2.0 envelope.
#
# The test creates its own working directory under /tmp/cognit-smoke
# and tears it down on exit so re-runs are idempotent.

set -euo pipefail

WORK="/tmp/cognit-smoke-atomic-$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

dest="$WORK/${EVENT_ID:-01HATOMIC000000000000000}-01HEVENT000000000000000.json"
payload='{"version":"1.2.0","type":"observation_recorded","session_id":"01HSESSION000000000000000","actor_name":"test","actor_type":"worker","id":"01HEVENT000000000000000","payload":{"text":"hello"}}'

python3 - "$dest" "$payload" <<'PY'
import os, sys, json
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

# 1. Destination file exists.
if [[ ! -f "$dest" ]]; then
  echo "FAIL: destination file not created at $dest" >&2
  exit 1
fi

# 2. Mode is 0o600.
mode="$(stat -c '%a' "$dest" 2>/dev/null || stat -f '%Lp' "$dest")"
if [[ "$mode" != "600" ]]; then
  echo "FAIL: expected mode 0o600, got 0o$mode" >&2
  exit 1
fi

# 3. No `.tmp` sibling left behind.
if [[ -e "${dest}.tmp" ]]; then
  echo "FAIL: .tmp sibling was not renamed: ${dest}.tmp" >&2
  exit 1
fi

# 4. JSON content parses as a valid v1.2.0 envelope.
if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required for content verification" >&2
  exit 1
fi
version="$(jq -r '.version' "$dest")"
if [[ "$version" != "1.2.0" ]]; then
  echo "FAIL: expected version=1.2.0, got version=$version" >&2
  exit 1
fi
actor_name="$(jq -r '.actor_name' "$dest")"
if [[ "$actor_name" != "test" ]]; then
  echo "FAIL: expected actor_name=test, got actor_name=$actor_name" >&2
  exit 1
fi
# Round-trip parse — must not throw.
jq empty "$dest" >/dev/null

echo "PASS: atomic-write (mode=0o600, no .tmp, valid v1.2.0 envelope at $dest)"
exit 0
