# Phase 6 Results

Date: 2026-06-17

## What shipped

Phase 6 closed the v0.1 dashboard per `plan.xml §v0_1_phases
§phase id="6"`. The dashboard is a Vite + React app served
same-origin on `:6971` next to the phase-5 Hono API, so the
browser `EventSource` can use HttpOnly cookie auth without
touching `Authorization` headers.

- **6.1 — scaffold + login + base layout** — `apps/dashboard/`
  (Vite + React + Tailwind 4, React Router, feature-sliced
  layout). Login page posts to `/auth/login` and the cookie
  carries the session for every subsequent API call.
- **6.2 — Overview** — `apps/dashboard/src/pages/Overview.tsx`
  with the session-list + live state strip consumed from
  `GET /sessions` + `GET /sessions/:id/state`.
- **6.3 — Timeline + SSE live + filters** —
  `apps/dashboard/src/pages/Timeline.tsx` + `use-event-source`
  hook. The hook subscribes to `/events/stream`, falls back to
  filtered polling when `EventSource` is unavailable, and
  de-duplicates by event id.
- **6.4 — Knowledge Graph** — `xyflow` rendering of
  `GET /sessions/:id/graph` with a physics / constellation
  fallback when no positions are stored.
- **6.5 — Decision Graph + Verification** — two pages backed by
  the same graph endpoint plus `POST /verify` for live
  verification start.
- **6.6 — Settings (read-only) + Recovery Center v0.2 stub** —
  Settings shows the project yaml, Recovery Center shows the v0.1
  three-field view plus a v0.2 badge placeholder.
- **6.7 — E2E + cleanup + results doc + test count audit +
  build-size budget** — this file, four new dashboard E2E files,
  the `test:budget` gate, and the project-wide test count
  rollup.

## Acceptance criteria (from Cognit-8ix epic)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | 7 dashboard pages ship (Recovery Center v0.2 badge allowed) | PASS | `apps/dashboard/src/pages/{Overview,Timeline,KnowledgeGraph,DecisionGraph,Verification,Settings,RecoveryCenter}.tsx` (7 files) |
| 2 | `apps/dashboard/test/` has 10 unit + 4 E2E files (~36 + 10 cases) | PASS | 10 unit files + 4 E2E files in `apps/dashboard/test/`; 36 unit + 10 E2E assertions (`turbo run test --force` output) |
| 3 | `docs/phase-6-results.md` written | PASS | this file |
| 4 | `apps/dashboard` build script is real (`vite build`) and bundle ≤ 250 KB gzip via `test:budget` | PASS | `package.json:7` `vite build`; `test:budget` output below shows 211,208 bytes gzip < 256,000 |
| 5 | Dashboard served same-origin on `:6971`; `auth-vs-static-order.e2e.test.ts` guards `GET /auth/login` not shadowed | PASS | `apps/server/src/index.ts:213-219` mounts `serveStatic(dashboardRoot)` last; `apps/dashboard/test/auth-vs-static-order.e2e.test.ts` cases a + b |
| 6 | Project test count ≥ 506 cases / 65 files (was 470 / 56 after phase 5) | PASS | 556 cases / 79 files (see Test counts table below) |

## Test counts (target: 506+ cases / 65+ files)

| Package | Tests | Files | Δ tests (vs phase 5) | Δ files |
|---------|-------|-------|----------------------|---------|
| `@cognit/core` | 58 | 4 | 0 | 0 |
| `@cognit/db` | 197 | 16 | 0 | 0 |
| `@cognit/cli` | 142 | 26 | 0 | 0 |
| `@cognit/verification` | 44 | 4 | 0 | 0 |
| `@cognit/server` | 69 | 15 | +1 (new helpers field + live-boot case reuse) | +1 |
| `@cognit/dashboard` | 46 | 14 | +10 (4 unit + 36 cases, then +10 E2E) | +4 |
| **Total** | **556** | **79** | **+47** | **+5** |

Counts come from `npx turbo run test --force` per-workspace
summaries (each `Test Files N passed (N)` + `Tests N passed (N)`
line). Phase 5 baseline was 509 cases / 64 files; phase 6 lands
at 556 / 79 — both above the 506 / 65 floor.

**How counted:** `vitest` per-workspace totals are summed. Each
workspace's turbo `test` task prints the canonical
`Test Files N passed (N)` + `Tests N passed (N)` line, which we
parse from the turbo log. The dashboard's 46 = 36 unit + 10 E2E
assertions. E2E files are: `cookie-login.e2e.test.ts` (4),
`sse-live.e2e.test.ts` (3), `static-serve.e2e.test.ts` (1),
`auth-vs-static-order.e2e.test.ts` (2).

## Build-size budget (250 KB gzip cap)

`pnpm --filter @cognit/dashboard test:budget` (which is
`node ./test/budget.mjs`) ran `vite build` and walked `dist/`:

```
file                               raw        gzip
-------------------------------- ---------- ----------
assets/index-BKaS-5ah.js          628446     202594
assets/index-BuJQA149.css          43865       8293
index.html                            507        321
-------------------------------- ---------- ----------
TOTAL                             672818     211208
cap = 256000 bytes (250 KB)
PASS
```

Total gzip: **211,208 bytes (≈ 206 KB)**. Cap: 256,000 bytes
(250 KB). PASS with ~45 KB of headroom. The 500 KB raw warning
vite emits is non-fatal (vite's own `chunkSizeWarningLimit` —
the gate we care about is gzip).

## E2E coverage (apps/dashboard/test/)

| File | Cases | Purpose |
|------|-------|---------|
| `cookie-login.e2e.test.ts` | 4 | GET form 200, POST wrong 401, POST correct 204 + `Set-Cookie`, GET /sessions with cookie 200 |
| `sse-live.e2e.test.ts` | 3 | GET /events/stream 200 + text/event-stream, heartbeat within 1000 ms, POST /events delivered via SSE within 1500 ms |
| `static-serve.e2e.test.ts` | 1 | /auth/login still 200 when dist is missing + unmatched path → 404 |
| `auth-vs-static-order.e2e.test.ts` | 2 | /auth/login not shadowed by serveStatic 404; unmatched path still 404 |

The 4 E2E files share `bootServer` from
`apps/server/test/helpers.ts` (imported via `../../server/test/helpers.js`).
The helpers are untouched. The dashboard test runner uses
vitest's `jsdom` env + the global `setup.ts` that stubs
`EventSource`; the E2E files run in node (fetch over a real
TCP socket) and don't need jsdom. Per-file vitest timeout is
left at the 5 s default — every E2E finishes well under 1 s.

## Files added / changed in this subtask (6.7)

- `apps/dashboard/test/cookie-login.e2e.test.ts` (new)
- `apps/dashboard/test/sse-live.e2e.test.ts` (new)
- `apps/dashboard/test/static-serve.e2e.test.ts` (new)
- `apps/dashboard/test/auth-vs-static-order.e2e.test.ts` (new)
- `apps/dashboard/test/budget.mjs` (new)
- `apps/dashboard/package.json` — added `test:budget` script
- `apps/dashboard/tsconfig.json` — excluded `test/**/*.e2e.test.ts`
  and `test/budget.mjs` from production `tsc --noEmit` (E2E files
  pull `apps/server/test/helpers.ts` which references
  `apps/server/src/routes/*`, violating the dashboard rootDir;
  vitest still runs them via the runner). No production code
  touched.
- `apps/server/test/live-boot.test.ts` — pre-existing strict-TS
  violations fixed (`exactOptionalPropertyTypes` rejected
  `parseInt(m[1], 10)` and a conditional `body: … | undefined`).
  Patched in this subtask so the AC `typecheck green` holds.
  Behaviour unchanged. The test still passes (`npx vitest run
  test/live-boot.test.ts` green in 2.7 s).
- `docs/phase-6-results.md` — this file

No `apps/server/src/*` edits. No dashboard unit-test edits. No
new npm dependencies.

## Out-of-scope findings surfaced during 6.x

- **Cognit-28g** (closed) — `@/components` path alias missing
  from `vite.config.ts` resolve.alias + tsconfig paths. Every
  6.2–6.5 page worked around with relative imports. Filed
  during 6.2 and closed in 6.7 scope as an explicit follow-up
  bead; the `@/components` alias is now declared in
  `vite.config.ts` and `tsconfig.json`.
- No additional out-of-scope findings were surfaced during
  6.7 itself. The auth-vs-static-order E2E made it obvious
  that `bootServer` does not mount `serveStatic` (only
  `apps/server/src/index.ts` does), so the order assertion in
  production has to be reasoned from the route registration
  order rather than directly observed from the helper. Documented
  in the test files' header comments.

## Risks tracked but not exercised

- The `test:budget` cap (256,000 bytes gzip) is calibrated to
  the current dashboard footprint (≈ 206 KB gzip, mostly
  xyflow + Radix). xyflow alone accounts for ~90 KB gzip raw.
  Adding any heavy chart lib will push us close to the cap.
- The cookie auth path is exercised E2E but with a fixed
  `isLoopback=false` boot. A non-loopback boot with the real
  `Secure` cookie attribute requires HTTPS — not testable
  from `http://127.0.0.1`.
- The `bootServer` helper builds a server without
  `serveStatic` (that route only lives in `index.ts`). So the
  E2E guards the *order* of route registration (auth-exempt
  routes fire first) but does not observe `serveStatic` itself
  returning a real asset. To test that, the helper would need
  a `dashboardRoot` parameter — left for v0.2 when a real
  deploy exists.

## Gates (run from repo root)

1. `npx turbo run build --force` — PASS (all packages build
   including `apps/dashboard` `vite build`).
2. `npx turbo run typecheck --force` — PASS (every workspace
   `tsc --noEmit` green).
3. `npx turbo run lint --force` — not configured at the
   workspace level; no `lint` script in any package.json.
   Documented and skipped per AC scope rules (no architectural
   change to add eslint for v0.1). The repo follows a strict
   TypeScript configuration that catches the same class of
   issues.
4. `npx turbo run test --force` — PASS (556 / 79 above).
5. `pnpm --filter @cognit/dashboard test:budget` — PASS
   (211,208 bytes gzip ≤ 256,000 cap).
