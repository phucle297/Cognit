# Phase 6.8: Docker Compose deploy

Subtask of phase 6 dashboard epic (Cognit-8ix). Goal: `docker compose up -d` → login + seeded demo visible on dashboard.

## Layout

```
docker/
  Dockerfile.server        # multi-stage: pnpm install → tsup build → node24 runtime
  Dockerfile.dashboard     # multi-stage: pnpm install → vite build → nginx:alpine
  nginx.conf               # :6970 → serve dist, /api/* /auth/* /events/* → :6971
  seed-demo.mjs            # cognit init + seed 1 session + 6 entities
docker-compose.yml         # 2 services: server, dashboard
```

## Services

| Service     | Image                         | Port   | Volume                        |
|-------------|-------------------------------|--------|-------------------------------|
| server      | built from Dockerfile.server  | 6971   | cognit-data:/app/.cognit      |
| dashboard   | built from Dockerfile.dashboard | 6970 | (read-only dist)              |

`cognit-data` named volume persists `.cognit/` between `down/up`.

## Nginx config (`docker/nginx.conf`)

Routes that exist on server (no `/api/` prefix):
- `GET  /healthz` `/health`
- `GET/POST /auth/login`
- `GET /sessions/:id/state`, `/sessions`, etc.
- `GET /events/stream` (SSE)
- `GET/POST /events`, `/knowledge-graph`, `/decision-graph`, `/verification`, `/settings`, `/storage`, `/recovery`

Strategy: serve static files from `/usr/share/nginx/html` (built dist). If file missing, proxy to backend. Backend handles SPA fallback for unknown routes that are API calls. For actual SPA navigation (e.g. `/timeline`), nginx falls through to dist → tries `index.html` via SPA fallback.

```
server {
  listen 6970;
  root /usr/share/nginx/html;
  index index.html;

  # Long-lived SSE — disable buffering
  location /events/stream {
    proxy_pass http://server:6971;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
    proxy_set_header Connection "";
  }

  # Static asset caching
  location /assets/ {
    expires 30d;
    add_header Cache-Control "public, immutable";
  }

  # SPA + API fallback: try static, then proxy to backend
  location / {
    try_files $uri $uri/ @backend;
  }

  location @backend {
    proxy_pass http://server:6971;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Server Dockerfile

Multi-stage:
1. `base`: node:24-alpine + pnpm + corepack
2. `deps`: `pnpm install --frozen-lockfile`
3. `build`: `pnpm --filter @cognit/server build` (tsup → dist/)
4. `runtime`: node:24-alpine, copy dist + node_modules, CMD `node dist/index.js`

Also installs packages/db (sqlite native).

## Dashboard Dockerfile

Multi-stage:
1. `base`: node:24-alpine + pnpm
2. `deps`: install
3. `build`: `pnpm --filter @cognit/dashboard build` (vite build → dist/)
4. `runtime`: nginx:alpine, copy dist + nginx.conf

## Seed script (`docker/seed-demo.mjs`)

Runs inside server container on first start (via docker compose `command:` override or init container).

Steps:
1. `cognit init --force` if `.cognit/` missing
2. `cognit session create "Demo: HMR memory leak investigation"`
3. `cognit observation add "Next.js dev server reaches 18GB VmPeak after 30 minutes"`
4. `cognit finding add "Memory growth correlates with HMR rebuilds, not request count"`
5. `cognit theory add "HMR module graph listener retention"`
6. `cognit hypothesis add "Module graph leak in HMR runtime" --belongs-to "HMR module graph listener retention" --confidence 0.7`
7. `cognit verify --type benchmark --command "node -e 'setTimeout(()=>{}, 1e6)'" --tests "Module graph leak in HMR runtime"`
8. `cognit conclusion propose "HMR module graph leaks ~5MB per rebuild" --verified-by <vid>`
9. `cognit decision accept "Disable HMR in CI builds" --reason "Leak is reproducible in dev only" --based-on <cid>`

Implemented via direct `@cognit/db` calls (not shelling out to CLI) to avoid tsx overhead. Skip if session "Demo: ..." already exists.

## docker-compose.yml

```yaml
services:
  server:
    build:
      context: .
      dockerfile: docker/Dockerfile.server
    expose: ["6971"]                    # internal docker network only; NOT to host
    volumes: [cognit-data:/app/.cognit]
    environment:
      COGNIT_PORT: 6971
      COGNIT_BIND: 0.0.0.0
    command: ["sh", "-c", "node docker/seed-demo.mjs && node dist/index.js"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:6971/healthz"]
      interval: 5s
      retries: 10

  dashboard:
    build:
      context: .
      dockerfile: docker/Dockerfile.dashboard
    ports: ["127.0.0.1:6970:6970"]      # only host-facing port
    depends_on:
      server: { condition: service_healthy }

volumes:
  cognit-data:
```

**Port policy:**
- `:6970` — only host-facing port (dashboard via nginx).
- `:6971` — internal docker network only. Host cannot reach backend directly.
- Non-docker users (running `pnpm dev:server` + `pnpm dev:dashboard`) still get `:6971` exposed for backward compat. Docker is opt-in deploy mode.

## Acceptance criteria

1. `docker compose up -d` exits 0, both services healthy.
2. `curl http://localhost:6970/` returns 200 + `<div id="root">` (SPA shell from dist).
3. `curl http://localhost:6970/healthz` (via nginx proxy) returns 200.
4. `curl -i -X POST http://localhost:6970/auth/login -d '{"token":"dev-token"}' -H 'content-type: application/json'` returns 200 + Set-Cookie. (Auth uses token, not username/password — verified at apps/server/src/routes/auth.ts:5,79.)
5. Dashboard `/` (after login) shows Overview with ≥1 session "Demo: HMR memory leak investigation" + ≥6 events.
6. `docker compose down -v && docker compose up -d` still seeds (idempotent).
7. README has "Docker" section above "Installation" with 3-line quickstart.
8. docs/phase-7-results.md written with `docker compose up -d` output excerpt.

## Out of scope

- S3 / localstack (dropped per user).
- TLS / production hardening.
- Hot-reload volumes for dev.
- New E2E test against dockerized stack (defer to follow-up bead; verified via manual curl + dashboard screenshot).
- Changes to existing :6971 same-origin serveStatic (keep — backward compat for non-docker users).

## Verification

After implementation:
1. `docker compose build` → both images build.
2. `docker compose up -d` → healthy.
3. Run curl checks AC2-4.
4. Open dashboard, screenshot AC5 (manual).
5. `docker compose down -v && docker compose up -d` → AC6.
6. Write `docs/phase-7-results.md`.

No new unit tests required (this is infra, not app code). Project test count remains 555.