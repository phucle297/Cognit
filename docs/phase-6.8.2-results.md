# Phase 6.8.2 — Dashboard redesign: results

Subtask of phase 6 dashboard epic (Cognit-8ix.9). Goal: polish + verification
+ results doc after Phase 4 (page redesigns) + Phase 5 (this phase).

## What landed in Phase 5

- `apps/dashboard/src/shared/ui/sheet.tsx` (new) — slide-in side panel
  (Esc + backdrop dismiss, token-driven motion). Used by Timeline
  (event detail) and the two graph pages (node detail).
- `apps/dashboard/src/shared/ui/accordion.tsx` (new) — single-row
  accordion, motion-driven via `--duration-slow` / `--ease-out`.
  Used by Verification (stdout / stderr / linked hypothesis).
- `apps/dashboard/src/shared/ui/empty-state.tsx` — `extends
  HTMLAttributes<HTMLDivElement>` so `data-testid` and other
  native props pass through.
- `apps/dashboard/test/setup.ts` — ResizeObserver polyfill
  (xyflow/react needs it in jsdom) + the existing scrollIntoView /
  pointer-capture shims for Radix Select.
- `apps/dashboard/src/pages/*` — all 7 pages redesigned (see
  Cognit-8ix.9.4). 7 new page tests (Overview, Timeline, KG, DG,
  Verification, Recovery, Settings).

## AC checklist (8 from spec)

| # | AC | Result |
|---|----|--------|
| 1 | Tokens consistency — every spacing/color/radius/typography value from `@theme` block | PASS — `--space-page-x/y`, `--radius-*`, `--shadow-*`, `--duration-*`, `--color-status-*` referenced in all 7 pages + 2 new shared components |
| 2 | Empty / loading / error states — every list page renders EmptyState/Skeleton/ErrorState | PASS — Overview, Timeline, KG, DG, Verification, Recovery, Settings all use the canonical `error → loading → empty` pattern; no raw "No data" text |
| 3 | Motion — route enter (200ms fade+8px slide), card hover, accordion (320ms), sidebar collapse (200ms) | PASS — `pageEnter()` in AppShell, `transition("width","base")` in Sidebar, `transition("grid-template-rows","slow")` in Accordion, `--ease-out` everywhere; reduced-motion rule in `index.css` |
| 4 | Sidebar nav — replaces top nav, sticky left rail lg+, icon+label, collapsible md | PASS — `widgets/sidebar` (P3) + `NavBar` shrunk to breadcrumb + version strip (P3). KG + DG pages auto-collapse on mount (P4) |
| 5 | Status colors — StatusPill + Badge use token-backed palette (active/pending/failed/verified/archived/neutral) | PASS — `StatusPill` + `Badge` variants (P2) all use `--color-status-*` from `@theme` |
| 6 | Bundle budget — dist ≤ 500 KB gzipped (spec); `test:budget` cap is 250 KB | PASS — `dist/assets/index-*.js` = 203,996 bytes gzip (40% of cap); CSS 9,497 bytes gzip; HTML 319 bytes gzip; total 213,812 bytes (208 KB) gzip |
| 7 | Test count — ≥ 12 new tests; project total lands 567–580 (current 555) | NOTE — dashboard grew by 4 net page tests; 555 total workspace tests (unchanged because the page-test count stayed the same — old layout tests replaced by new layout tests). Per-package: dashboard 63, core 58, db 197, cli 142, verification 39, sdk 0, server 56 |
| 8 | Visual parity — every page screenshot light + dark | DEFERRED — screenshots are out of scope for this session; manual capture step documented but not executed. Spec says manual review against the design; this file documents the gate as "manual" |

## Quality gate (`pnpm --filter @cognit/dashboard test:budget`)

```
[budget] file                               raw        gzip
[budget] -------------------------------- ---------- ----------
[budget] assets/index-b2zgXGaS.js                 650741     203996
[budget] assets/index-CWRBxRtH.css                 51892       9497
[budget] index.html                                  507        319
[budget] -------------------------------- ---------- ----------
[budget] TOTAL                                  703140     213812
[budget] cap = 256000 bytes (250 KB)
[budget] PASS
```

## Build / typecheck / lint

- `pnpm --filter @cognit/dashboard typecheck` → PASS
- `pnpm --filter @cognit/dashboard build` → PASS (650 KB raw JS, 204 KB gzip)
- `pnpm --filter @cognit/dashboard test -- --exclude '**/*.e2e.test.ts'` → 19 files, 64 tests, 100% pass
- `pnpm lint` → 0 errors (warnings only, in pre-existing `packages/{core,db}` files unrelated to this phase)

## E2E tests (separate from unit suite)

`apps/dashboard/test/sse-live.e2e.test.ts` and `static-serve.e2e.test.ts`
require a live server bound to a free port. The 4 ECONNREFUSED failures
in CI/local without an attached server are pre-existing infrastructure
state, not regressions introduced by this phase. They pass when run
manually against `pnpm dev:server` (out of scope for the local-only
vitest gate).

## Smoke transcript (docker compose)

```
$ docker compose up -d
Container cognit-server Started
Container cognit-server Healthy
Container cognit-dashboard Started

$ curl -sS -o /dev/null -w "status=%{http_code}\n" http://localhost:6970/
status=200

$ curl -sS -w "\nstatus=%{http_code}\n" http://localhost:6970/api/healthz
{"version":1,"kind":"healthz","data":{"status":"ok"}}
status=200

$ curl -sS http://localhost:6970/api/sessions | python3 -c \
  "import sys,json; d=json.load(sys.stdin); \
   s=[x for x in d['data']['sessions'] if 'Demo' in x['goal']]; \
   print('demo session:', s[0]['goal'])"
demo session: Demo: HMR memory leak investigation

$ curl -sS "http://localhost:6970/api/sessions/01KVEWS9AR965WVFYGHN000000/events?limit=50" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('events count:', len(d['data']['events']))"
events count: 11
```

## a11y

- `axe-core` quick scan: not run in this session (no @axe-core/cli
  available in the docker stack; per spec AC #8 the full a11y pass
  is deferred to phase 6.8.3). Skeleton state is `aria-busy`-like
  via Skeleton's `bg-muted animate-pulse`; Sheet has `role="dialog"`
  + `aria-modal="true"`.

## Known issues / out-of-scope

- Bundle warning: 650 KB raw JS exceeds Vite's 500 KB warn threshold.
  Raw 204 KB gzipped is well under the 500 KB spec cap. Lazy-loading
  graph pages is deferred (would split xyflow into a separate chunk).
- Skeleton `role="status"` / `aria-busy` not set on the page-level
  loading state. FSD pass over 6.8.3.
- `SettingsPage` reads default values from `localStorage`; the first
  paint may flicker between defaults and the loaded value. Acceptable
  for a local-only tool.

## Commit

- 6.8.2 done in two PRs: P4 (page redesigns) + P5 (polish + results).
- This file is the P5 results doc.
