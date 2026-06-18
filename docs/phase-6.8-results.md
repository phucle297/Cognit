# Phase 6.8 — Docker Compose deploy: results

Subtask of phase 6 dashboard epic (Cognit-8ix). Goal: `docker compose up -d`
→ login + seeded demo visible on dashboard at http://localhost:6970.

## What landed

- `docker/Dockerfile.server` — multi-stage. `base` (node:24-alpine + pnpm via
  corepack) → `deps` (apk add python3 make g++ libc6-compat for the
  better-sqlite3 native binding; `sed` blanks the dev-only
  `pkill turbo` `preinstall`) → `build` (`pnpm --filter @cognit/server
  build` → tsup with `noExternal: [/^@cognit\//]` so the workspace
  source is inlined into a single 187 KB ESM bundle; `ulid` and the
  3rd-party native deps stay external) → `runtime` (node:24-alpine, the
  bundle + the inlined migration .sql + the seed script + a /data
  volume).
- `docker/Dockerfile.dashboard` — multi-stage. `base` → `deps` (same
  build toolchain) → `build` (`pnpm --filter @cognit/dashboard build`
  via vite) → `runtime` (nginx:alpine, the dist + `docker/nginx.conf`).
- `docker/nginx.conf` — `:6970` serves the dist, proxies the API
  surface (`/healthz`, `/auth/*`, `/events/stream`, `/sessions/*`,
  `/projects`, `/edges`, `/verify`, `/actors`,
  `/knowledge-graph`, `/decision-graph`, `/verification`,
  `/settings`, `/storage`, `/recovery`) to the `server:6971`
  upstream. `/events/stream` has `proxy_buffering off` +
  `proxy_read_timeout 24h` for SSE. The `^/(api)$` regex location
  avoids the v0.1 trap where `try_files ... /index.html` served the
  SPA shell for `POST /auth/login` and nginx returned 405.
- `docker/seed-demo.mjs` — idempotent. On a fresh volume it
  bootstraps `.cognit/`, runs the v1.0.0 + v1.1.0 migrations
  inline, inserts a `cognit-demo` project + three actors
  (`claude-seed`, `seed`, `cognit-system`), then inserts a
  `Demo: HMR memory leak investigation` session with 11 events:
  `session_created`, `observation_recorded`, `finding_created`,
  `theory_created`, `hypothesis_created` (also writes a
  `hypotheses` row so the dashboard reducer resolves the
  entity), `verification_started`, `verification_passed` (with
  v1.1.0 outcome columns: `stdout_excerpt`, `exit_code`,
  `duration_ms`), `conclusion_proposed`, `conclusion_verified`,
  `decision_proposed`, `decision_accepted`. On every
  subsequent run a single `SELECT id FROM sessions WHERE goal = ?`
  short-circuits the whole insert block.
- `docker-compose.yml` — 2 services. `server` is `expose: ["6971"]`
  (internal docker network only) + a `cognit-data` named volume
  mounted at `/data`; the `command:` runs the seed and then execs
  the server. `dashboard` is `127.0.0.1:6970:6970` (host-facing
  only) + `depends_on: server: { condition: service_healthy }`.
  Healthcheck is `wget -qO- http://127.0.0.1:6971/healthz` every 5s.
- `apps/server/tsup.config.ts` (new) — tsup config that bundles
  the workspace TS source. Added so the runtime image only needs
  `dist/index.js` + 3rd-party / native deps; without `noExternal`
  every `@cognit/*` import in the bundle resolves to a workspace
  symlink that does not exist in the runtime image.
- `apps/server/package.json` — `build` script now `tsup` (was
  `tsup src/index.ts --format esm --target node24 --clean --dts`).
  `ulid` is now an explicit dependency so pnpm symlinks it into
  `apps/server/node_modules/`; tsup externalizes it so the
  CommonJS UMD bundle can use Node's `require("crypto")` (the
  inlined copy, which uses `__require` from tsup's prelude, does
  not work in an ESM context).

## `docker compose up -d` — fresh volume

```
$ docker compose up -d
 Container cognit-server Healthy
 Container cognit-dashboard Started

$ docker logs cognit-server
[seed] wrote /data/.cognit/cognit.yaml
[seed] wrote /data/.cognit/.gitignore
[seed] applied migration 1.1.0
[seed] created project cognit-demo (01KVCJDGVD2DPC8QYX8X000000)
[seed] registered actor claude-seed (worker)
[seed] registered actor seed (human)
[seed] registered actor cognit-system (system)
[seed] seeded demo session 01KVCJDGVE0QG2SFK1CT000000 with 11 events
cognit-server: bearer auth enabled (bind=0.0.0.0, cookie=cognit_session)
serveStatic: root path '/apps/dashboard/dist' is not found, are you sure it's correct?
cognit-server: listening on http://0.0.0.0:6971
cognit-server: project=01KVCJDGVD2DPC8QYX8X000000 db=/data/.cognit/cognit.db auth=bearer+cookie bind=0.0.0.0
```

(The `serveStatic` warning is the server's optional dev-mode
fallback that serves the dashboard dist on `:6971`. In the docker
setup the dashboard is fronted by nginx on `:6970`, so the path
does not exist on purpose. The warning is harmless.)

## AC checks

```
$ curl -s -o /tmp/root.html -w "HTTP %{http_code}\n" http://localhost:6970/
HTTP 200
$ grep -c '<div id="root"' /tmp/root.html
1

$ curl -s -w "HTTP %{http_code}\n" -o /tmp/h.json http://localhost:6970/healthz
HTTP 200
$ cat /tmp/h.json
{"version":1,"kind":"healthz","data":{"status":"ok"}}

$ curl -s -i -X POST http://localhost:6970/auth/login \
    -H 'content-type: application/json' -d '{"token":"dev-token"}' | head -8
HTTP/1.1 204 No Content
Server: nginx/1.31.2
set-cookie: cognit_session=dev-token; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400

$ curl -s -b "cognit_session=dev-token" http://localhost:6970/sessions
{"version":1,"kind":"sessions.list","data":{"sessions":[
  {"id":"01KVCJDGVE0QG2SFK1CT000000","goal":"Demo: HMR memory leak investigation",
   "status":"active", ...}
]}}

$ S=$(curl -s -b "cognit_session=dev-token" http://localhost:6970/sessions \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['sessions'][0]['id'])")
$ curl -s -b "cognit_session=dev-token" "http://localhost:6970/sessions/$S/events" \
    | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['events']))"
11
```

## Idempotency (`docker compose down -v && docker compose up -d`)

```
$ docker compose down
 Network cognit_default Removed
$ docker volume rm cognit_cognit-data
cognit_cognit-data
$ docker compose up -d
 Container cognit-server Healthy
 Container cognit-dashboard Started
$ docker logs cognit-server
[seed] wrote /data/.cognit/cognit.yaml
[seed] wrote /data/.cognit/.gitignore
[seed] applied migration 1.1.0
[seed] created project cognit-demo (...)
[seed] seeded demo session ... with 11 events
```

A second `docker compose restart server` (no `-v`) hits the
short-circuit:

```
$ docker compose restart server
$ docker logs cognit-server
[seed] demo session already present (id=...); nothing to do
```

## Out of scope (per plan)

- S3 / localstack.
- TLS / production hardening.
- Hot-reload volumes for dev.
- New E2E test against the dockerized stack.
- Changes to the existing `:6971` same-origin serveStatic — left
  intact for non-docker users (`pnpm dev:server` +
  `pnpm dev:dashboard`).

## Known dev quirks

- The root `package.json` ships with a `preinstall` script that
  runs `pkill -f 'turbo.*daemon' || true`. It serves a purpose in
  local dev (kills a stuck turbo daemon between runs) but trips
  pnpm's strict lifecycle handling in a one-shot docker build
  where `pkill` is missing or returns 1. The Dockerfiles `sed`
  blank it before `pnpm install --frozen-lockfile`. Keep the
  dev script intact; the patch is docker-only.
- The runtime image is dominated by `node_modules` (~650 MB).
  Future work can `pnpm deploy` to ship a pruned subset; out of
  scope for v0.1.

## Project test count

No new unit tests were added (this is infra, not app code). The
project test count remains 555 per `docs/phase-6-results.md`.
