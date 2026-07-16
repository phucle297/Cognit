#!/usr/bin/env bash
# test-maybe-drain.sh — unit-ish smoke for cognits_realtime_wanted / debounce gate.
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${TEST_DIR}/../shared/hook-lib.sh"

SMOKE="/tmp/cognit-smoke-maybe-drain-$$"
mkdir -p "$SMOKE/.cognit/inbox"
trap 'rm -rf "$SMOKE"' EXIT
cd "$SMOKE"

# 1) default ON when no yaml
unset COGNIT_REALTIME || true
if ! cognits_realtime_wanted; then
  echo "FAIL: expected realtime wanted with no yaml" >&2
  exit 1
fi

# 2) yaml false → off
cat > .cognit/cognit.yaml <<YAML
project:
  name: t
inbox:
  realtime: false
YAML
if cognits_realtime_wanted; then
  echo "FAIL: expected off when yaml realtime false" >&2
  exit 1
fi

# 3) env override ON even when yaml false
COGNIT_REALTIME=1
if ! cognits_realtime_wanted; then
  echo "FAIL: env=1 should force on" >&2
  exit 1
fi
unset COGNIT_REALTIME

# 4) yaml true → on
cat > .cognit/cognit.yaml <<YAML
project:
  name: t
inbox:
  realtime: true
YAML
if ! cognits_realtime_wanted; then
  echo "FAIL: yaml true should be on" >&2
  exit 1
fi

# 5) env=0 overrides yaml true
COGNIT_REALTIME=0
if cognits_realtime_wanted; then
  echo "FAIL: env=0 should force off" >&2
  exit 1
fi

echo "PASS: cognits_realtime_wanted"
