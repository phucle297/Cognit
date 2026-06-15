# syntax=docker/dockerfile:1.7
# Dockerfile — single image, run any part of the monorepo via APP_NAME.
#
# Build once, run anything:
#   docker build -t cognit .                                    # APP_NAME=server (default)
#   docker build --build-arg APP_NAME=cli -t cognit-cli .       # CLI one-shot
#   docker build --build-arg APP_NAME=dev -t cognit-dev .       # turbo dev
#
# Run:
#   docker run --rm -p 6971:6971 cognit                        # server on :6971
#   docker run --rm cognit-cli observe "hello"                  # one-shot CLI
#   docker compose up                                           # server + volume

ARG NODE_VERSION=22.14.0-bookworm-slim

# ── deps stage: install all deps for the workspace ──────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages packages
COPY apps apps
RUN pnpm install --frozen-lockfile

# ── build stage: compile TS via tsc per package ────────────────────
FROM deps AS build
RUN pnpm -r run build

# ── runtime stage: slim image with built artefacts ─────────────────
FROM node:${NODE_VERSION} AS runtime
ARG APP_NAME=server
ENV APP_NAME=${APP_NAME}
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
# Copy workspace + built outputs (no devDeps, no source TS).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY docker/entrypoint.sh /usr/local/bin/cognit-entrypoint
RUN chmod +x /usr/local/bin/cognit-entrypoint
# Default data dir; mount a volume here for persistence.
RUN mkdir -p /data
ENV COGNIT_ROOT=/data
EXPOSE 6971
ENTRYPOINT ["/usr/local/bin/cognit-entrypoint"]
CMD []
