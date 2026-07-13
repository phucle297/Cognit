#!/bin/sh
# docker/entrypoint.sh — dispatch on APP_NAME to run one part of the
# Cognit monorepo. Build with `--build-arg APP_NAME=<name>` or leave
# unset for the default (server).
#
#   APP_NAME=server  (default)  Hono read API on :6971
#   APP_NAME=cli                 CLI one-shot — pass subcommand + args
#                               e.g. `docker run --rm cognit observe "hi"`
#   APP_NAME=dev                 turbo dev (all packages with a dev script)
#   APP_NAME=all                 same as server (the only long-running
#                               service until the dashboard lands)
#
# Volumes: mount a host dir at /data and pass --root /data (server) or
# the equivalent CLI flag to persist `.cognit/` outside the container.

set -eu

cd /app

# Run a single part of the monorepo. No prebuilt bin required —
# `tsx` is hoisted to the package's own node_modules by pnpm, so we
# invoke the source file directly. This matches how the CLI's
# `cognit server` subcommand spawns the server in dev.
case "${APP_NAME:-server}" in
  server)
    exec ./apps/server/node_modules/.bin/tsx apps/server/src/index.ts \
      --host 0.0.0.0 --port "${PORT:-6971}" \
      ${COGNIT_ROOT:+--root "$COGNIT_ROOT"}
    ;;
  cli)
    # Prefer built dist when present (production image); fall back to tsx source.
    if [ -f apps/cli/dist/index.js ]; then
      exec node apps/cli/dist/index.js \
        ${COGNIT_ROOT:+--root "$COGNIT_ROOT"} "$@"
    fi
    exec ./apps/cli/node_modules/.bin/tsx apps/cli/src/index.ts \
      ${COGNIT_ROOT:+--root "$COGNIT_ROOT"} "$@"
    ;;
  dev)
    exec pnpm run dev
    ;;
  all)
    # Until the dashboard ships, "all" is just the server.
    exec ./apps/server/node_modules/.bin/tsx apps/server/src/index.ts \
      --host 0.0.0.0 --port "${PORT:-6971}" \
      ${COGNIT_ROOT:+--root "$COGNIT_ROOT"}
    ;;
  *)
    echo "docker/entrypoint.sh: unknown APP_NAME='$APP_NAME'" >&2
    echo "expected: server | cli | dev | all" >&2
    exit 2
    ;;
esac
