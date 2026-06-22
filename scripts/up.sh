#!/usr/bin/env bash
# scripts/up.sh — single-command local startup.
#
# Builds + links @cognit/cli onto the host PATH, then starts the backend
# server in Docker. Replaces the manual three-command install:
#
#   pnpm install
#   pnpm build
#   cd apps/cli && pnpm link --global
#   docker compose up -d
#
# Why split host vs container: apps/cli depends on better-sqlite3, a
# native module. pnpm install inside the Alpine-based Docker image
# produces the musl prebuild, which won't load on glibc Linux hosts or
# on macOS. Running the CLI half on the host gives correct libc
# matching; the server still runs fully containerized.
#
# Usage:
#   scripts/up.sh                      # cold install + start
#   scripts/up.sh --build              # force image rebuild
#   scripts/up.sh --force-recreate     # recreate containers
#
# Requirements: Node 24 LTS, pnpm 9, Docker.

set -euo pipefail

# Resolve repo root from this script's location.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Detect host pnpm global dir. pnpm 9 Linux default is
# ~/.local/share/pnpm; macOS uses ~/Library/pnpm; custom prefixes vary.
# Allow override via PNPM_HOME for non-standard setups.
PNPM_HOME="${PNPM_HOME:-$(pnpm config get global-dir 2>/dev/null || true)}"
if [ -z "$PNPM_HOME" ]; then
  PNPM_HOME="${HOME}/.local/share/pnpm"
fi
export PNPM_HOME

printf '→ pnpm install (host, native prebuilds for better-sqlite3)\n'
pnpm install --frozen-lockfile

printf '→ build @cognit/cli (tsup + copy-migrations)\n'
pnpm --filter @cognit/cli build

printf '→ link @cognit/cli → %s/bin\n' "$PNPM_HOME"
( cd apps/cli && pnpm link --global )

printf '→ docker compose up -d (server on :6971 internal)\n'
docker compose up -d "$@"

cat <<EOF

✓ ready
  cognit:   $PNPM_HOME/bin/cognit
  server:   docker compose ps   (cognit-server)
  dashboard: opt-in — docker compose --profile dashboard up -d

If 'cognit' is not on PATH:
  export PATH="$PNPM_HOME/bin:\$PATH"
EOF
