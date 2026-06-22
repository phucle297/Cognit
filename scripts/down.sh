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

PNPM_HOME="${PNPM_HOME:-$(pnpm config get global-dir 2>/dev/null || true)}"
[ -z "$PNPM_HOME" ] && PNPM_HOME="${HOME}/.local/share/pnpm"

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

# 2. Global CLI link — inverse of `pnpm link --global` in up.sh.
if [ -L "${PNPM_HOME}/cognit" ] || [ -e "${PNPM_HOME}/cognit" ]; then
  printf '→ pnpm unlink --global @cognit/cli (bin: %s/cognit)\n' "$PNPM_HOME"
  ( cd apps/cli && pnpm unlink --global 2>/dev/null ) || true
  # Belt-and-braces: pnpm unlink leaves the bin file behind on some setups.
  rm -f "${PNPM_HOME}/cognit"
else
  printf '→ skip pnpm unlink (no global cognit bin)\n'
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
  cli:      global @cognit/cli link removed (bin: ${PNPM_HOME}/cognit)
  state:    .cognit/ $( [ "$PURGE" -eq 1 ] && echo 'wiped' || echo 'kept' )
  modules:  node_modules + .turbo $( [ "$CLEAN" -eq 1 ] && echo 'wiped' || echo 'kept' )
  beads:    .beads/ untouched (separate issue tracker)

reinstall: scripts/up.sh
EOF
