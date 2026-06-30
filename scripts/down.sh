#!/usr/bin/env bash
# scripts/down.sh — single-command local teardown. Mirror of up.sh.
#
# Usage:
#   scripts/down.sh                      # teardown docker + unlink CLI
#   scripts/down.sh --purge              # also wipe .cognit/ local state
#   scripts/down.sh --clean              # also pnpm clean (node_modules + .turbo)
#   scripts/down.sh --purge --clean      # full nuke
#   scripts/down.sh --yes                # skip confirmations
#
# Why host teardown: up.sh links @cognit/cli onto the host PATH so
# better-sqlite3 gets the glibc prebuild, not the musl one from the
# Alpine image. down.sh must remove that global link too, or 'cognit'
# stays on PATH pointing at a stale dist.
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

# Resolve pnpm global bin dir the same way up.sh does. Prefer `pnpm bin -g`.
PNPM_BIN="$(pnpm bin -g 2>/dev/null || true)"
if [ -z "$PNPM_BIN" ] || [ "$PNPM_BIN" = "undefined" ]; then
  PNPM_BIN="${PNPM_HOME:-${HOME}/.local/share/pnpm}"
fi

confirm() {
  $YES && return 0
  local prompt="$1"
  read -r -p "$prompt [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

# 1. Docker — stop + wipe named volume.
if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
  printf '→ docker compose down -v (wipe cognit-data volume)\n'
  docker compose down -v --remove-orphans 2>/dev/null || true
  printf '→ removing cognit-server / cognit-dashboard images\n'
  docker image rm -f cognit:server cognit:dashboard 2>/dev/null || true
else
  printf '→ skip docker (no docker or no compose file)\n'
fi

# 2. Global CLI link — inverse of up.sh's direct symlink + shim.
# Removes the bin shim + the global/5/node_modules symlink directly.
# Bypasses `pnpm unlink --global` to avoid pnpm's global-store check
# (fails when pnpm version changes between installs).
COGNIT_BIN="${PNPM_BIN}/cognit"
COGNIT_LINK="${PNPM_BIN}/global/5/node_modules/@cognit/cli"

if [ -L "$COGNIT_BIN" ] || [ -e "$COGNIT_BIN" ]; then
  printf '→ removing @cognit/cli bin shim (bin: %s)\n' "$COGNIT_BIN"
  rm -f "$COGNIT_BIN"
else
  printf '→ no @cognit/cli bin shim under %s\n' "$PNPM_BIN"
  COGNIT_BIN=""
fi

if [ -L "$COGNIT_LINK" ]; then
  printf '→ removing @cognit/cli global link (%s)\n' "$COGNIT_LINK"
  rm -f "$COGNIT_LINK"
fi

# 3. Local state — only on --purge.
if [ "$PURGE" -eq 1 ]; then
  if [ -d .cognit ]; then
    if confirm "delete .cognit/ (cognit.db, agent state, inbox, artifacts)?"; then
      printf '→ rm -rf .cognit/\n'
      rm -rf .cognit
    fi
  fi
else
  printf '→ keep .cognit/ (use --purge to wipe)\n'
fi

# 4. Build artifacts — only on --clean.
if [ "$CLEAN" -eq 1 ]; then
  if confirm "run pnpm clean (delete node_modules + .turbo across workspaces)?"; then
    printf '→ pnpm clean\n'
    pnpm clean
  fi
else
  printf '→ keep node_modules + .turbo (use --clean to wipe)\n'
fi

cat <<EOF

✓ teardown complete
  docker:   containers + cognit-data volume removed
  cli:      global @cognit/cli link removed (bin: ${COGNIT_BIN:-not found})
  state:    .cognit/ $( [ "$PURGE" -eq 1 ] && echo 'wiped' || echo 'kept' )
  modules:  node_modules + .turbo $( [ "$CLEAN" -eq 1 ] && echo 'wiped' || echo 'kept' )
  beads:    .beads/ untouched (separate issue tracker)

reinstall: scripts/up.sh
EOF