#!/usr/bin/env bash
#
# cc-drain.sh — lifecycle drain hook (Stop / SessionEnd / SubagentStop).
#
# Does NOT write an observation envelope. Only flushes
# `.cognit/inbox/*.json` → SQLite so the dashboard sees the turn that
# just finished. Wired by `cognit init` for Claude Code + Grok Build.
#
# Force mode: skips the 2s debounce used by per-tool producers so the
# end-of-turn / end-of-session drain always runs.
#
# Failure policy: always exit 0 — never block the host agent.
set -euo pipefail

_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
if [[ -f "${_HOOK_DIR}/hook-lib.sh" ]]; then
  source "${_HOOK_DIR}/hook-lib.sh"
elif [[ -f "${_HOOK_DIR}/../shared/hook-lib.sh" ]]; then
  source "${_HOOK_DIR}/../shared/hook-lib.sh"
else
  # Missing lib: still try a raw process if cognit is on PATH.
  if command -v cognit >/dev/null 2>&1; then
    (cognit inbox --process >/dev/null 2>&1 &) || true
  fi
  exit 0
fi

# Discard stdin (hosts may pipe event JSON; we only care about CWD).
cat >/dev/null 2>&1 || true

cognits_maybe_drain force || true
exit 0
