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
#   scripts/up.sh                      # cold install + start (Docker + CLI link)
#   scripts/up.sh --no-docker          # install + link CLI only (no Docker)
#   scripts/up.sh --build              # pass-through to docker compose --build
#   scripts/up.sh --force-recreate     # pass-through to docker compose --force-recreate
#
# Requirements: Node 22+, pnpm 9, Docker (optional with --no-docker).

set -euo pipefail

# Minimum pnpm version. No exact pin — any pnpm >= min works.
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

# Resolve repo root from this script's location.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Parse flags. Docker-related flags pass through to `docker compose up -d`.
NO_DOCKER=0
DOCKER_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-docker)        NO_DOCKER=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    --) shift; DOCKER_ARGS+=("$@"); break ;;
    *)                  DOCKER_ARGS+=("$arg") ;;
  esac
done

# Resolve pnpm global bin dir. Prefer `pnpm bin -g` (always reflects the
# active pnpm install) over `pnpm config get global-dir` (returns the
# literal string "undefined" on some pnpm 9 setups, which breaks fallback).
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
# Direct symlink + custom bin shim. Bypasses `pnpm link --global` so we
# don't trip pnpm's global-store layout check (which fails when pnpm
# version changes between installs — store/v10 vs store/v10/v3 drift).
GLOBAL_NM="$PNPM_BIN/global/5/node_modules"
mkdir -p "$GLOBAL_NM/@cognit"
ln -sfn "$REPO_ROOT/apps/cli" "$GLOBAL_NM/@cognit/cli"
cat > "$PNPM_BIN/cognit" <<EOF
#!/usr/bin/env node
import("$REPO_ROOT/apps/cli/dist/index.js").catch((e) => { console.error(e); process.exit(1); });
EOF
chmod +x "$PNPM_BIN/cognit"

if [ "$NO_DOCKER" -eq 1 ]; then
  cat <<EOF

✓ ready (CLI only — server not started)
  cognit:   $PNPM_BIN/cognit
  server:   skipped (--no-docker). Run \`docker compose up -d\` when ready,
            or \`cognit server\` to run it on the host (loopback :6971).
  dashboard: cognit dashboard                # vite dev on :5173
             cognit dashboard --docker       # nginx on :6970

If 'cognit' is not on PATH:
  export PATH="$PNPM_BIN:\$PATH"
EOF
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  printf '! docker not found on PATH — skipping server start.\n' >&2
  printf '  re-run with --no-docker to suppress this message, or install Docker.\n' >&2
  cat <<EOF

✓ ready (CLI only — docker missing)
  cognit:   $PNPM_BIN/cognit
  server:   NOT started (docker not installed)
  dashboard: cognit dashboard

If 'cognit' is not on PATH:
  export PATH="$PNPM_BIN:\$PATH"
EOF
  exit 0
fi

printf '→ docker compose up -d (server on :6971 internal)\n'
docker compose up -d "${DOCKER_ARGS[@]}"

cat <<EOF

✓ ready
  cognit:   $PNPM_BIN/cognit
  server:   docker compose ps   (cognit-server)
  dashboard: opt-in — docker compose --profile dashboard up -d

If 'cognit' is not on PATH:
  export PATH="$PNPM_BIN:\$PATH"
EOF