#!/usr/bin/env bash
# scripts/down.sh — teardown host CLI link (mirror of up.sh). No Docker.
#
# Usage:
#   scripts/down.sh                      # unlink CLI
#   scripts/down.sh --purge              # also wipe this repo's .cognit/ (if any)
#   scripts/down.sh --clean              # also pnpm clean (node_modules + .turbo)
#   scripts/down.sh --purge --clean      # full nuke of install artifacts
#   scripts/down.sh --yes                # skip confirmations
#
# Does NOT touch .beads/ (separate issue tracker, user-managed).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PURGE=0
CLEAN=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --purge)   PURGE=1 ;;
    --clean)   CLEAN=1 ;;
    -y|--yes)  YES=1 ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      printf 'unknown flag: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

PNPM_BIN="$(pnpm bin -g 2>/dev/null || true)"
if [ -z "$PNPM_BIN" ] || [ "$PNPM_BIN" = "undefined" ]; then
  PNPM_BIN="${PNPM_HOME:-${HOME}/.local/share/pnpm}"
fi

COGNIT_BIN=""
if [ -x "$PNPM_BIN/cognit" ]; then
  COGNIT_BIN="$PNPM_BIN/cognit"
elif command -v cognit >/dev/null 2>&1; then
  COGNIT_BIN="$(command -v cognit)"
fi

printf '→ unlink host CLI\n'
if [ -n "$COGNIT_BIN" ] && [ -e "$COGNIT_BIN" ]; then
  rm -f "$COGNIT_BIN"
  printf '  removed %s\n' "$COGNIT_BIN"
fi
GLOBAL_NM="$PNPM_BIN/global/5/node_modules/@cognit/cli"
if [ -L "$GLOBAL_NM" ] || [ -e "$GLOBAL_NM" ]; then
  rm -rf "$GLOBAL_NM"
  printf '  removed %s\n' "$GLOBAL_NM"
fi

# Best-effort: stop leftover containers from the old Docker setup.
if command -v docker >/dev/null 2>&1; then
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'cognit-server'; then
    printf '→ remove leftover cognit-server container (old Docker setup)\n'
    docker rm -f cognit-server 2>/dev/null || true
  fi
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'cognit-dashboard'; then
    printf '→ remove leftover cognit-dashboard container (old Docker setup)\n'
    docker rm -f cognit-dashboard 2>/dev/null || true
  fi
  docker image rm -f cognit:server cognit:dashboard 2>/dev/null || true
  docker volume rm -f cognit_cognit-data 2>/dev/null || true
fi

if [ "$PURGE" -eq 1 ]; then
  if [ "$YES" -ne 1 ]; then
    printf 'About to rm -rf %s/.cognit — type yes: ' "$REPO_ROOT"
    read -r ans
    [ "$ans" = "yes" ] || { printf 'aborted\n'; exit 1; }
  fi
  if [ -d "$REPO_ROOT/.cognit" ]; then
    printf '→ purge %s/.cognit\n' "$REPO_ROOT"
    rm -rf "$REPO_ROOT/.cognit"
  fi
fi

if [ "$CLEAN" -eq 1 ]; then
  printf '→ pnpm clean\n'
  pnpm run clean 2>/dev/null || true
fi

printf '\n'
printf '✓ removed\n'
printf '  cli:      global cognit link cleared\n'
printf '  leftovers: old cognit Docker containers/images cleaned if present\n'
printf '  next:     pnpm run setup   # to reinstall CLI\n'
