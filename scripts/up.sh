#!/usr/bin/env bash
# scripts/up.sh — install Cognit CLI on the host (no Docker).
#
#   pnpm install
#   build @cognit/cli
#   link `cognit` onto the host PATH
#
# Runtime model (local-first):
#   cd <your-project> && cognit init
#   cognit dashboard   # spawns API for that project's .cognit + Vite UI
#
# Usage:
#   scripts/up.sh                 # install + link CLI
#   pnpm run setup                # same
#   scripts/up.sh -h
#
# Requirements: Node 22+, pnpm 9.

set -euo pipefail

MIN_PNPM_MAJOR=9
MIN_PNPM_MINOR=0
PNPM_VERSION_RAW="$(pnpm --version 2>/dev/null || true)"
if [ -z "$PNPM_VERSION_RAW" ]; then
  printf '! pnpm not found on PATH. Install pnpm >=%d.%d.\n' "$MIN_PNPM_MAJOR" "$MIN_PNPM_MINOR" >&2
  exit 1
fi
PNPM_MAJOR="$(printf '%s' "$PNPM_VERSION_RAW" | cut -d. -f1)"
PNPM_MINOR="$(printf '%s' "$PNPM_VERSION_RAW" | cut -d. -f2)"
if [ "$PNPM_MAJOR" -lt "$MIN_PNPM_MAJOR" ] || \
   { [ "$PNPM_MAJOR" -eq "$MIN_PNPM_MAJOR" ] && [ "$PNPM_MINOR" -lt "$MIN_PNPM_MINOR" ]; }; then
  printf '! pnpm %s found, >=%d.%d required.\n' "$PNPM_VERSION_RAW" "$MIN_PNPM_MAJOR" "$MIN_PNPM_MINOR" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    --no-docker|--build|--force-recreate)
      printf 'note: %s is ignored (Docker is no longer part of setup)\n' "$arg" >&2
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
export PNPM_BIN

printf '→ pnpm install (host, native prebuilds for better-sqlite3)\n'
pnpm install --frozen-lockfile

printf '→ build @cognit/cli (tsup + copy-migrations)\n'
pnpm --filter @cognit/cli build

printf '→ link @cognit/cli → %s\n' "$PNPM_BIN/cognit"
GLOBAL_NM="$PNPM_BIN/global/5/node_modules"
mkdir -p "$GLOBAL_NM/@cognit"
ln -sfn "$REPO_ROOT/apps/cli" "$GLOBAL_NM/@cognit/cli"
# shellcheck disable=SC2016
printf '%s\n' '#!/usr/bin/env node' "import(\"$REPO_ROOT/apps/cli/dist/index.js\").catch((e) => { console.error(e); process.exit(1); });" > "$PNPM_BIN/cognit"
chmod +x "$PNPM_BIN/cognit"

printf '\n'
printf '✓ ready (host-only — no Docker)\n'
printf '  cognit:    %s\n' "$PNPM_BIN/cognit"
printf '  next:\n'
printf '    cd /path/to/your-project\n'
printf '    cognit init\n'
printf '    cognit dashboard --no-open\n'
printf '      # UI  http://127.0.0.1:6970\n'
printf '      # API http://127.0.0.1:6971  (this project'\''s .cognit)\n'
printf '\n'
printf 'If '\''cognit'\'' is not on PATH:\n'
printf '  export PATH="%s:$PATH"\n' "$PNPM_BIN"
