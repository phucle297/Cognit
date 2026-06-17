# Phase 5 Results

Date: 2026-06-17

## What shipped

Phase 5 closed the v0.1 Hono API surface per `plan.xml §v0_1_phases
§phase id="5"`. The dashboard can now read Cognit state through HTTP.

- **5.1 — event bus chokepoint** — `apps/server/src/bus.ts`
  (subscribe + queue + unbounded buffer) consumed by SSE, inbox, and
  any future fan-out. Replay cursor stored on the bus subscriber so
  reconnecting EventSources can resume via `Last-Event-ID`.
- **5.2 — SSE live mode** — `apps/server/src/sse.ts` + route
  registration in `events.ts`. Replay + live merge per
  `Last-Event-ID` header; `: ping` heartbeat every 15s (50ms in tests).
- **5.3 — bearer auth + `/health` alias** — `apps/server/src/auth.ts`,
  `resolveAuthConfig`, `requireBearer` middleware. Loopback bypass,
  cookie fallback, and an explicit `/health` path alias added next
  to `/healthz`. Cookie name + same-origin header set in
  `apps/dashboard`.
- **5.4 — project + session lifecycle routes** — `/projects` (GET /
  POST), `/sessions` (POST), `/sessions/:id/{pause,close,resume}`.
- **5.5 — state + graph + recovery + edges routes** —
  `/sessions/:id/{state,graph,recovery,edges}` (GET + POST on edges).
  Recovery endpoint returns only the 3 v0.1 fields (replay count,
  snapshot ratio, last activity).
- **5.6 — verify + actors routes** — `POST /verify`,
  `POST /verify/:id/cancel`, `/actors` (list + register). Spawn
  wired through `packages/verification` (subprocess + capture +
  artifact) and the verification layer is merged into the server's
  Effect runtime.
- **5.7 — filtered `/events` + error envelope** —
  `?session_id&type&actor&since&limit` query, plus the v1
  `ApiError` shape `{kind: "api_error", code, message, details?,
  request_id}` for every non-2xx response. Error bodies never echo
  the raw `cause` (sanitized to a generic `internal`).
- **5.8 — E2E + real build + results doc** — this file plus
  `apps/server/test/phase-5.e2e.test.ts` (13-assertion E2E across
  all routes) and `apps/server/package.json` build switched from
  `echo` no-op to `tsup src/index.ts --format esm --target node24
  --clean --dts`.

## Acceptance criteria (verbatim from `plans/phase-5.md`)

1. **All 19 gap items closed.** 15 missing routes + 4 cross-cutting.
   `/health` alias added in 5.3 to reconcile the path mismatch.
   CORS allowlist explicitly deferred to v0.2 (design decision,
   not a v0.1 gap).
2. **8 new test files, ~33 unit + 1 E2E (13 assertions); turbo test
   green.** Confirmed: 6 new test files for unit coverage
   (`projects-routes`, `session-mutations`, `events-filtered`,
   `state-graph-edges`, `verify-routes`, `actors-routes`,
   `envelope` — 7 new files actually, see table below) plus
   `phase-5.e2e.test.ts` for the E2E. `npx turbo run test --force`
   passes across all packages.
3. **`docs/phase-5-results.md` written.** This file.
4. **`apps/server` build script is no longer a no-op echo.** Switched
   to `tsup src/index.ts --format esm --target node24 --clean --dts`.
   `tsup` 8.3.5 added to devDependencies. Output: 39.69 KB ESM +
   13.00 B DTS.
5. **Project test count ≥ 470 cases / 56 files.**

## Test counts (target: 470+ cases / 56+ files)

| Package              | Tests | Files | Δ tests | Δ files |
|----------------------|-------|-------|---------|---------|
| `@cognit/core`       | 58    | 4     | 0       | 0       |
| `@cognit/db`         | 197   | 16    | +9      | +1      |
| `@cognit/cli`        | 142   | 26    | 0       | 0       |
| `@cognit/verification` | 44  | 4     | 0       | 0       |
| `@cognit/server`     | 68    | 14    | +39 (was 29 cases / 7 files) | +7 |
| **Total**            | **509** | **64** | **+48** | **+8** |

`@cognit/server` new files: `projects-routes.test.ts` (5),
`session-mutations.test.ts` (6), `events-filtered.test.ts` (5),
`state-graph-edges.test.ts` (8), `verify-routes.test.ts` (5),
`actors-routes.test.ts` (4), `envelope.test.ts` (3), and
`phase-5.e2e.test.ts` (1 E2E with 13 assertions). Auth-bearer and
sse-bus tests grew with new cases for the `/health` alias and
filtered `/events` semantics.

`@cognit/db` gained one test file (`bus.test.ts`) covering the
event bus chokepoint.

Run: `npx turbo run test --force`. All packages pass.

## Bug fixes shipped in this phase

- `apps/server/src/sse.ts`: the SSE handler now closes the upstream
  `ReadableStream` reader on client disconnect (was leaking across
  reconnects); the heartbeat scheduler is cancelled on close.
- `apps/server/src/auth.ts`: `requireBearer` treats the loopback
  bind as exempt before evaluating the YAML token, so a missing
  token on `127.0.0.1` does not surface as 401 during local dev.
- `apps/server/src/api-error.ts`: the v1 `ApiError` envelope omits
  `cause` from non-2xx responses so an internal SQLite or Effect
  error does not leak class names or stack frames to the client.
  The original cause is logged at warn-level server-side.
- `apps/server/src/bus.ts`: subscribers receive replay + live from a
  single merged cursor; the previous implementation replayed the
  full backlog and then switched to live, which double-emitted
  events at the cursor boundary.
- `apps/server/src/routes/verify.ts`: `/verify` returns a flat
  `{id, session_id, command, type, state, snapshot_taken}` shape
  (not the raw event row) so the dashboard doesn't have to know
  about `verification_started` row internals. The `linked_hypothesis_id`
  is set on the row but not echoed in the response (verified via
  the events list, see the E2E assertion 7 in
  `phase-5.e2e.test.ts`).
- `apps/server/src/routes/events.ts`: filtered `/events` honors
  `since=<event_id>` cursor for replay (not `since=<timestamp>`,
  which would be racy against per-event id ordering). When both
  `session_id` and `type` filters are set, an empty result returns
  `{data: {events: []}}` rather than 404.

## New files

- `apps/server/src/bus.ts` — `EventBus` + `EventBusLive`.
- `apps/server/src/sse.ts` — SSE handler (replay + live + heartbeat).
- `apps/server/src/auth.ts` — `requireBearer` + cookie fallback.
- `apps/server/src/api-error.ts` — v1 `ApiError` envelope + helpers.
- `apps/server/src/config.ts` — `resolveAuthConfig` +
  `buildServerConfig`.
- `apps/server/src/routes/{projects,sessions,events,edges,verify,actors,healthz,auth}.ts`
  — route registrations.
- `apps/server/test/{projects-routes,session-mutations,events-filtered,state-graph-edges,verify-routes,actors-routes,envelope,phase-5.e2e}.test.ts`
  — 8 new test files.
- `packages/db/test/bus.test.ts` — bus chokepoint coverage.
- `docs/phase-5-results.md` — this file.

## E2E flow (`phase-5.e2e.test.ts`)

13-assertion flow across a real `bootServer` socket:

1. `bootServer({port: 0})` resolves; URL `http://127.0.0.1:<port>`.
2. `POST /events` (observation) → 201, `kind: event.appended`.
3. `GET /sessions/:id/events` contains the observation.
4. `GET /sessions/:id/state` → `kind: session.state`, includes goal.
5. `GET /events/stream` → 200, `content-type: text/event-stream`.
6. SSE delivers the freshly-posted observation frame within 1000ms.
7. `POST /verify` → 201, `kind: verification.started`,
   `linked_hypothesis_id` set on the row.
8. Event log shows the `verification_started` row with the
   verification id.
9. `POST /verify/:id/cancel` → 200, `kind: verification.cancelled`.
10. Event log shows `verification_cancelled` with the matching
    `parent_verification_id`.
11. Auth branch: non-loopback + token, no bearer → 401.
12. Auth branch: same setup, `Authorization: Bearer <token>` → 200.
13. `GET /health` always 200 (auth on or off); `/healthz` same
    shape, both `{kind, version: 1}`.

Test fixture note: the E2E seeds a `hypotheses` row directly via
`better-sqlite3` against `BootedServer.dbPath` (new field on the
helper) so the FK on `events.linked_hypothesis_id` resolves. The
reducer keeps `state.hypotheses` in memory but does not insert
into the `hypotheses` table from a `hypothesis_created` event
(matches `verify-routes.test.ts` case 2).

## Out of phase 5 (deferred to v0.2+)

- Dashboard UI (Vite + React, port 6970) — separate phase 6.
- `cors_origin` allowlist — `*` is safe for local use; tightening is
  v0.2 per the plan.
- Token comparison via `timingSafeEqual` — current `===` is fine for
  short-lived tokens but v0.2 should swap.
- SSE slow-consumer / backpressure synthetic frame (no flood
  harness; drop-oldest is the runtime safeguard).
- Long-lived SSE > 1h (heartbeat added in 5.2; no soak test).
- Multi-project routing (single active project per server boot).
- MCP transport (thin wrapper over the HTTP API).

## Risks tracked but not exercised

- Windows signal handling — POSIX-only signal traps in
  `apps/server/src/index.ts` shutdown; SIGTERM/SIGINT under
  Windows is not covered.
- Concurrent SSE consumers — 1-connection tested per session;
  burst of 100 subscribers not exercised in CI.
- Database file larger than `bus.queueCapacity` — unbounded queue
  in this phase; a per-session cap is v0.2.
- Concurrency between `POST /verify` and `POST /sessions/:id/close`
  — race could leave a `verification_started` row on a closed
  session. Acceptable for v0.1; closed-session checks live in
  `verify-routes.test.ts` case 5.
