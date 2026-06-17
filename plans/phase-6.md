# Phase 6 — Dashboard (v0.1 MVP)

> Status: plan. Phase 5 (Cognit-w61 Hono API) closed 2026-06-17. Phase 6 =
> build the Vite+React dashboard that consumes the phase 5 surface, per
> `plan.xml §v0_1_phases §phase id="6"`. **Same-origin on :6971** (not
> :6970) — phase 5.3.5 already serves `./apps/dashboard/dist` from the API
> server, and `EventSource` cannot carry `Authorization` so the dashboard
> must be same-origin to use the `cognit_session` cookie.
> Combined design + build plan. Read top-to-bottom = build order.

## Done-when (from `plan.xml:775` + `v0_1_success_criteria:846`)

> Dashboard opens on port 6971 (same-origin) and shows Overview, Timeline,
> Knowledge Graph, Decision Graph, Verification, Settings. Recovery Center
> either renders with a "v0.2" badge or is omitted — the full recovery
> output block ships in v0.2.

## Reality check (gap audit)

Phase 3 5vl.10 stubbed the dashboard. **No build, no pages, no deps, no
tests.** Phase 5.3.5 added `serveStatic` mounting `./apps/dashboard/dist`
behind cookie auth.

| Surface | Status |
|---|---|
| `apps/dashboard/` | `src/index.ts` exports `PHASE = 0`; no `vite.config.ts`, no `index.html` |
| Build script | `echo "dashboard: no build yet (Phase 6)"` |
| Deps | only `@cognit/core` (workspace), `typescript`, `vitest` |
| React/Vite/Tailwind | none installed |
| Pages | 0/7 (Overview, Timeline, Knowledge Graph, Decision Graph, Verification, Recovery Center, Settings) |
| Auth UX | `/auth/login` form exists server-side, no client page renders it |
| SSE consumer | none |
| Tests | 0 |
| Static-serve mount | `app.get("*", serveStatic({ root: "./apps/dashboard/dist" }))` in `apps/server/src/index.ts:209-219` |

## Scope decision (v0.1 vs v0.2)

`plan.xml:846` allows Recovery Center to render with a "v0.2" badge. We do
that. Settings ships a **read-only** view in v0.1 (project config + storage
usage) and defers the redaction-patterns editor and export/import buttons
to v0.2.

| Page | v0.1 | v0.2 |
|---|---|---|
| Overview | full | — |
| Timeline | full + live SSE + filters | — |
| Knowledge Graph | full + physics/constellation toggle | — |
| Decision Graph | full (subset of /state) | — |
| Verification | full + rerun history | — |
| Recovery Center | "v0.2" badge placeholder | full recovery block + fuzzy search |
| Settings | read-only config + storage usage | redaction editor + export/import buttons |

## API surface used (audit from phase 5)

Read endpoints consumed by the dashboard:

| Method + Path | Used by |
|---|---|
| `GET /health` (or `/healthz`) | boot probe, login page |
| `POST /auth/login` | login form |
| `GET /projects` | Overview |
| `GET /sessions` | Overview |
| `GET /sessions/:id/state` | Overview, Decision Graph, Verification |
| `GET /sessions/:id/recovery` | Recovery Center stub |
| `GET /sessions/:id/events` | Timeline (initial) |
| `GET /events/stream` | Timeline (live) — cookie auth, same-origin |
| `GET /sessions/:id/graph` | Knowledge Graph |
| `GET /sessions/:id/edges` | Knowledge Graph filters |
| `GET /actors` | Settings + Timeline filter |
| `GET /events?…` | filtered events (used by Timeline actor/type filter) |

Mutations used by the dashboard (mutations are still v0.1 but not
required by `done_when`):

- `POST /projects` (Overview "new project" form)
- `POST /sessions/:id/{pause,close,resume}` (Settings/lifecycle panel)
- `POST /verify` (Verification page "rerun" button)
- `POST /verify/:id/cancel` (Verification page "cancel" button)

Session-scoped SSE **does not exist**. Timeline filters the project-wide
stream by `event.session_id` client-side. A new endpoint
`GET /sessions/:id/events/stream` is **deferred** to v0.2.

## Cross-cutting decisions

### Stack

Per `STACK.md §Frontend`:

- **React 19** + **Vite 5** + **TypeScript 5.7.2** (workspace pin)
- **Tailwind CSS 4** + `@tailwindcss/vite` (CSS-first config, no JS config)
- **shadcn/ui** (copy-paste, no runtime dep)
- **@xyflow/react v12** (renamed `reactflow`) for graph viz
- **react-router-dom v7** (unified `react-router` v7)
- **react-hook-form + Effect Schema** (form types = API types)
- **vitest 2.1.8** + **@testing-library/react 16** + **jsdom 25**

No React Query (v0.1 is read-only; plain `fetch` + a tiny `useApi` hook).

### Build & serve

- `apps/dashboard/index.html` is the Vite entry.
- `apps/dashboard/vite.config.ts`: `base: "./"`, `build.outDir: "dist"`,
  `build.emptyOutDir: true`, dev proxy: `server.proxy = { "/": "http://127.0.0.1:6971" }`
  so `pnpm --filter @cognit/dashboard dev` stays same-origin on :5173.
- Production: `cognit server` already serves `apps/dashboard/dist` via
  `serveStatic` catch-all. **Critical mount order:** `app.route(...)` for
  `/auth/*` and `/health` must be registered **before** `app.get("*", serveStatic)`
  (serveStatic is GET-only, so `POST /auth/login` is safe, but
  `GET /auth/login` form page would otherwise be shadowed by `index.html`).
  Verified by `auth-vs-static-order.e2e.test.ts`.

### Auth UX

- No `Authorization` header in JS. All `fetch(..., { credentials: "include" })`.
- `EventSource` does not accept custom headers; same-origin sends cookies
  automatically. Use `new EventSource("/events/stream", { withCredentials: true })`.
- Login page (`/login` route): renders the form returned by `GET /auth/login`
  (server-rendered) OR a client form that POSTs to `/auth/login` with
  `{ token }`. **Decision:** client form (controlled input → POST → 204 → push `/`).
- Logout: v0.1 omits. Closing the browser clears the cookie. v0.2 adds
  `POST /auth/logout`.

### SSE

- `useEventSource(url)` hook returns `{ events, status, close }`.
- Native `EventSource` (no polyfill). Reconnect is browser-driven; we
  rely on `id:` field from phase 5.2.1 for `Last-Event-ID` plumbing.
- Filter project-wide stream by `session_id` on the client.

### State management

- Local: `useState` + `useReducer`.
- Server state: `useApi(path, opts)` → `{ data, error, loading, refetch }`.
  No global store (forbidden by `STACK.md:173`).
- URL state: `useSearchParams` for filters (Timeline) and selected session.

### Styling

- Tailwind 4 with CSS-first config in `apps/dashboard/src/index.css`.
- shadcn/ui components copied into `apps/dashboard/src/components/ui/`
  (Button, Card, Input, Select, Badge, Tabs, Dialog, Tooltip).
- No `tailwind.config.js`. Theme via `@theme` block in CSS.

### Lint / format / typecheck

- Already workspace-wired: `oxlint .`, `oxfmt --check .`, `tsc --noEmit`.
- `apps/dashboard/tsconfig.json` adds `"jsx": "react-jsx"` and
  `"types": ["vitest/globals", "@testing-library/jest-dom"]`.

## Build order

```
0.  Confirm same-origin :6971 (no separate :6970 dashboard server)        [BLOCKER]
1.  6.1  Vite + React scaffold + dev proxy + login page + base layout    [foundation]
2.  6.2  Overview page                                                     [parallel with 6.3-6.5]
3.  6.3  Timeline page + SSE hook + filters                                [parallel with 6.2/6.4/6.5]
4.  6.4  Knowledge Graph page (xyflow + physics/constellation)            [parallel with 6.2/6.3/6.5]
5.  6.5  Decision Graph + Verification pages                               [parallel with 6.2/6.3/6.4]
6.  6.6  Settings (read-only) + Recovery Center ("v0.2" badge)             [parallel with 6.2-6.5]
7.  6.7  E2E + results doc + test count audit + build-size budget         [last]
```

Steps 2-6 are 5 disjoint workstreams touching disjoint files. **Step 1
must land first** (scaffold + dev proxy + login). **Step 7 last.**

## Subtasks (bd epic + children)

| ID | Title | P | Type | Files | Tests |
|---|---|---|---|---|---|
| 6.1 | Vite + React scaffold + login + base layout | P1 | chore | `apps/dashboard/{index.html,vite.config.ts,tsconfig.json}`, `src/{main.tsx,App.tsx,router.tsx,index.css}`, `src/lib/{api-client,use-api,use-event-source,format}.ts`, `src/components/ui/*` (shadcn copy), `src/pages/Login.tsx`, `src/components/{AppShell,NavBar}.tsx`; EDIT `apps/dashboard/package.json` (real build + deps) | `api-client.test.ts` (6), `use-event-source.test.ts` (5), `Login.test.tsx` (3) |
| 6.2 | Overview page | P1 | feature | `src/pages/Overview.tsx`, `src/components/{ProjectCard,NewProjectDialog}.tsx` | `Overview.test.tsx` (4) |
| 6.3 | Timeline page + SSE live + filters | P1 | feature | `src/pages/Timeline.tsx`, `src/components/{TimelineList,EventRow,FilterBar,PauseSseButton}.tsx` | `Timeline.test.tsx` (5) |
| 6.4 | Knowledge Graph (xyflow + physics/constellation) | P1 | feature | `src/pages/KnowledgeGraph.tsx`, `src/components/{GraphCanvas,GraphControls,NodeSidePanel}.tsx`, `src/lib/{force-simulation,node-colors}.ts` | `KnowledgeGraph.test.tsx` (4) |
| 6.5 | Decision Graph + Verification | P1 | feature | `src/pages/{DecisionGraph,Verification}.tsx`, `src/components/{DecisionList,VerificationList,RerunButton,CancelButton}.tsx` | `DecisionGraph.test.tsx` (3), `Verification.test.tsx` (3) |
| 6.6 | Settings (read-only) + Recovery Center v0.2 stub | P2 | feature | `src/pages/{Settings,RecoveryCenter}.tsx`, `src/components/{ConfigView,StorageUsage}.tsx` | `Settings.test.tsx` (2), `RecoveryCenter.test.tsx` (1) |
| 6.7 | E2E + cleanup + results doc + test count audit + build-size budget | P2 | chore | `apps/dashboard/test/*.e2e.test.ts` (4 NEW), `apps/dashboard/package.json` (build-size script), `docs/phase-6-results.md` (NEW) | 4 E2E (10 assertions) |

**7 subtasks. 6.1 must land first. 6.2-6.6 are 5 parallel workstreams.
6.7 last.**

---

## 6.1 — Vite + React scaffold + login + base layout

**Files (NEW unless noted):**
- `apps/dashboard/index.html`
- `apps/dashboard/vite.config.ts`
- `apps/dashboard/tsconfig.json` (add jsx + types)
- `apps/dashboard/src/main.tsx`
- `apps/dashboard/src/App.tsx`
- `apps/dashboard/src/router.tsx`
- `apps/dashboard/src/index.css` (Tailwind 4 + `@theme`)
- `apps/dashboard/src/lib/api-client.ts` (NEW; `apiFetch` w/ `credentials: "include"`, parses `{version, kind, data}` envelope, surfaces `api_error` code+message+request_id)
- `apps/dashboard/src/lib/use-api.ts` (NEW; `useApi(path, opts)` → `{ data, error, loading, refetch }`)
- `apps/dashboard/src/lib/use-event-source.ts` (NEW; SSE hook; reads `event.lastEventId`; backoff cap 30s; returns `{ events, status, close }`)
- `apps/dashboard/src/lib/format.ts` (NEW; ULID, ISO timestamp, payload summary)
- `apps/dashboard/src/components/ui/*` (shadcn copy: Button, Card, Input, Select, Badge, Tabs, Dialog, Tooltip — own the source)
- `apps/dashboard/src/components/AppShell.tsx` (NEW; layout: NavBar + Outlet)
- `apps/dashboard/src/components/NavBar.tsx` (NEW; links to Overview, Timeline, Knowledge Graph, Decision Graph, Verification, Recovery, Settings)
- `apps/dashboard/src/pages/Login.tsx` (NEW; controlled form; POST `/auth/login`; on 204, `navigate("/")`)
- `apps/dashboard/test/api-client.test.ts` (NEW; 6 cases)
- `apps/dashboard/test/use-event-source.test.ts` (NEW; 5 cases)
- `apps/dashboard/test/Login.test.tsx` (NEW; 3 cases)
- EDIT `apps/dashboard/package.json`: real `build`, `dev`, add deps

### 6.1.1 — `vite.config.ts`

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/": "http://127.0.0.1:6971" } },
  test: { environment: "jsdom", globals: true, setupFiles: ["./test/setup.ts"] },
});
```

### 6.1.2 — `apps/dashboard/package.json` (key edits)

```json
{
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest --run --passWithNoTests",
    "test:watch": "vitest",
    "test:browser": "playwright test"
  },
  "dependencies": {
    "@cognit/core": "workspace:*",
    "@xyflow/react": "^12.0.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.0",
    "lucide-react": "^0.400.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-hook-form": "^7.50.0",
    "react-router-dom": "^7.0.0",
    "tailwind-merge": "^2.5.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/jest-dom": "^6.4.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "tailwindcss": "^4.0.0",
    "tsx": "4.19.2",
    "typescript": "5.7.2",
    "vite": "^5.4.0",
    "vitest": "2.1.8"
  }
}
```

### 6.1.3 — `api-client.ts`

```ts
export type ApiSuccess<T> = { version: 1; kind: string; data: T };
export type ApiError = {
  kind: "api_error";
  code: string;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
};

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message ?? res.statusText), { api: body as ApiError });
  return (body as ApiSuccess<T>).data;
}
```

### 6.1.4 — `use-event-source.ts`

```ts
export type SseStatus = "connecting" | "open" | "closed";
export function useEventSource<T>(url: string | null): {
  events: ReadonlyArray<T>; status: SseStatus; close: () => void;
} { /* native EventSource; backoff cap 30s; reads lastEventId */ }
```

### 6.1.5 — Tests

`api-client.test.ts` (6): URL prefix (relative → resolved); `credentials: "include"` sent; success envelope unwrapped; `api_error` thrown with code+message+request_id; network error throws with `request_id`; `AbortSignal` respected.

`use-event-source.test.ts` (5): opens on mount; closes on unmount; reads `event.lastEventId`; backoff caps at 30000ms; parses `id:`/`event:`/`data:` triple.

`Login.test.tsx` (3): renders form; submit POSTs to `/auth/login`; on 204 navigates to `/`. (Mock `fetch`.)

**Smoke:** `pnpm --filter @cognit/dashboard build` produces `apps/dashboard/dist/index.html` + `assets/`.

---

## 6.2 — Overview page

**Files (NEW):**
- `apps/dashboard/src/pages/Overview.tsx`
- `apps/dashboard/src/components/ProjectCard.tsx`
- `apps/dashboard/src/components/NewProjectDialog.tsx`
- `apps/dashboard/test/Overview.test.tsx` (4 cases)

### 6.2.1 — Page layout

- Heading: "Projects".
- `<NewProjectDialog>` (button + Dialog form: `name`, `repo_url?`).
- `<ProjectCard>` grid: each card shows name, repo_url, `created_at`, recent-events count.
- Click card → `navigate("/timeline?session=<first-session>")` (or `/sessions/:id` if first-session lookup is a future enhancement; v0.1 picks first session from `GET /sessions` filtered by `project_id`).

### 6.2.2 — Data

- `useApi("/projects")` → `{ projects: ProjectRow[] }`
- `useApi("/sessions")` → `{ sessions: SessionRow[] }` (group by `project_id`)

### 6.2.3 — Tests

1. Renders empty state when no projects.
2. Renders N project cards from fixture.
3. Click card → `navigate("/timeline?session=…")`.
4. "New project" submit calls `apiFetch("/projects", { method: "POST", body })` and appends row.

---

## 6.3 — Timeline page + SSE live + filters

**Files (NEW):**
- `apps/dashboard/src/pages/Timeline.tsx`
- `apps/dashboard/src/components/TimelineList.tsx` (virtualized; `react-virtuoso` if event count > 100)
- `apps/dashboard/src/components/EventRow.tsx`
- `apps/dashboard/src/components/FilterBar.tsx` (type chips + actor debounced input)
- `apps/dashboard/src/components/PauseSseButton.tsx`
- `apps/dashboard/test/Timeline.test.tsx` (5 cases)

### 6.3.1 — Page layout

- Heading: "Timeline" + selected session goal.
- `<FilterBar>`: type chips (`hypothesis_proposed`, `decision_made`, `conclusion_verified`, `verification_started`, …); actor input (debounce 250ms); "Pause SSE" / "Resume SSE" toggle.
- `<TimelineList>`: reverse-chronological event list; `<EventRow>` shows actor, type, payload summary, ULID timestamp.

### 6.3.2 — Data

- Initial: `useApi("/sessions/:id/events?limit=50")`.
- Live: `useEventSource("/events/stream")` → filter by `event.session_id === id && passesFilter(event)`.
- "Pause SSE" → `close()` on the hook; "Resume SSE" → re-mount hook (new `EventSource`).

### 6.3.3 — Tests

1. Renders 50 events initially from fixture.
2. Type chip narrows visible events.
3. Actor input debounce fires after 250ms (assert no fetch before debounce, fetch after).
4. "Pause SSE" closes underlying `EventSource` (assert `EventSource.prototype.close` called).
5. New `EventSource` callback appends a row without remounting (assert key continuity).

---

## 6.4 — Knowledge Graph (xyflow + physics/constellation)

**Files (NEW):**
- `apps/dashboard/src/pages/KnowledgeGraph.tsx`
- `apps/dashboard/src/components/GraphCanvas.tsx` (`@xyflow/react` `<ReactFlow>`)
- `apps/dashboard/src/components/GraphControls.tsx` (layout toggle, edge-type filter, zoom)
- `apps/dashboard/src/components/NodeSidePanel.tsx`
- `apps/dashboard/src/lib/force-simulation.ts` (d3-force wrapper, `start()` / `stop()` / `tick()`)
- `apps/dashboard/src/lib/node-colors.ts` (entity_type → Tailwind class)
- `apps/dashboard/test/KnowledgeGraph.test.tsx` (4 cases)

### 6.4.1 — Page layout

- `<GraphControls>`: layout toggle (Physics / Constellation), edge-type multiselect, zoom reset.
- `<GraphCanvas>`: `<ReactFlow>` with custom `Node` per entity (coloured by type); `<Edge>` per graph edge.
- Click node → `<NodeSidePanel>` (drawer) shows entity payload + linked edges.

### 6.4.2 — Physics/constellation toggle

- Physics: `forceSimulation.start()`; on each `tick`, update node positions via `setNodes`.
- Constellation: `forceSimulation.stop()`; nodes pinned in a 2D grid by `entity_type`.

### 6.4.3 — Data

- `useApi("/sessions/:id/graph")` → `{ session_id, nodes: GraphNode[], edges: GraphEdge[] }`.
- Map `nodes[]` → xyflow `Node[]` (id = `entity_type:entity_id`).
- Map `edges[]` → xyflow `Edge[]`.

### 6.4.4 — Tests

1. Renders nodes + edges from fixture.
2. Physics toggle calls `simulation.alpha(1).restart()`.
3. Constellation toggle calls `simulation.stop()`.
4. Node click opens side panel (assert panel visible with payload).

### 6.4.5 — Performance guard

- Cap visible nodes at 500. > 500: show "Load more" paginator; auto-switch to constellation above 200 nodes (CPU friendly).

---

## 6.5 — Decision Graph + Verification pages

**Files (NEW):**
- `apps/dashboard/src/pages/DecisionGraph.tsx`
- `apps/dashboard/src/pages/Verification.tsx`
- `apps/dashboard/src/components/{DecisionList,VerificationList,RerunButton,CancelButton}.tsx`
- `apps/dashboard/test/{DecisionGraph,Verification}.test.tsx` (3 cases each)

### 6.5.1 — Decision Graph

- Heading: "Decisions".
- Two sections: **Accepted** (proposed → accepted), **Rejected** (rejected with `reason_type`).
- Each decision card shows: `based_on` conclusion ids (links → Conclusion rows), `caused` experiment ids (links → Experiment rows).
- "Superseded by" chain visualisation (linear list).

### 6.5.2 — Verification

- Heading: "Verifications".
- Grouped by `linked_hypothesis_id` (or by `parent_verification_id` for reruns).
- Each row: `command`, `type`, `state` (passed/failed/errored/cancelled), `started_at`, `completed_at`, `exit_code`.
- "Rerun" button → `apiFetch("/verify", { method: "POST", body: { command, type, linked_hypothesis_id, actor } })`.
- "Cancel" button → `apiFetch("/verify/:id/cancel", { method: "POST", body: { actor } })`; only enabled when `state` is `started`.

### 6.5.3 — Data

- `useApi("/sessions/:id/state")` → derive `state.decisions` and `state.verifications` maps.
- `useApi("/sessions/:id/edges?edge_type=based_on")` → `based_on` edges.
- `useApi("/sessions/:id/edges?edge_type=caused")` → `caused` edges.

### 6.5.4 — Tests

`DecisionGraph.test.tsx` (3): renders accepted + rejected; click `based_on` link navigates; superseded chain renders in order.

`Verification.test.tsx` (3): groups by `linked_hypothesis_id`; rerun button POSTs to `/verify`; cancel button POSTs to `/verify/:id/cancel` and is disabled on terminal states.

---

## 6.6 — Settings (read-only) + Recovery Center (v0.2 stub)

**Files (NEW):**
- `apps/dashboard/src/pages/Settings.tsx`
- `apps/dashboard/src/pages/RecoveryCenter.tsx`
- `apps/dashboard/src/components/{ConfigView,StorageUsage}.tsx`
- `apps/dashboard/test/{Settings,RecoveryCenter}.test.tsx` (2 + 1 cases)

### 6.6.1 — Settings (v0.1 subset)

- Heading: "Settings".
- `<ConfigView>`: read-only display of `cognit.yaml` (`auth.bind`, `auth.api_token` masked, `actors.defaults`, `redaction.patterns.count`).
- `<StorageUsage>`: bar showing events table size + artifacts count (from `GET /health` extended? **No — v0.1 just shows "X events, Y artifacts" derived from `/sessions` + `/events` counts; defer `/health` extension to v0.2**).
- **Out of v0.1:** redaction-patterns editor, export/import buttons, config write.

### 6.6.2 — Recovery Center (v0.2 stub)

- Heading: "Recovery Center".
- Badge: **"v0.2"** (per `plan.xml:846`).
- Body: short paragraph: "Full recovery output, fuzzy search, and suggested next steps land in v0.2. v0.1 shows 3 fields via `GET /sessions/:id/recovery`."
- Below: render the 3 v0.1 fields from `useApi("/sessions/:id/recovery")` (`rejected_hypotheses`, `verified_conclusions`, `accepted_decisions`) for completeness.

### 6.6.3 — Tests

`Settings.test.tsx` (2): renders config view with masked token; renders storage usage with event + artifact counts.

`RecoveryCenter.test.tsx` (1): renders "v0.2" badge.

---

## 6.7 — E2E + cleanup + results doc + test count audit + build-size budget

**Files (NEW):**
- `apps/dashboard/test/cookie-login.e2e.test.ts` (4 cases)
- `apps/dashboard/test/sse-live.e2e.test.ts` (3 cases)
- `apps/dashboard/test/static-serve.e2e.test.ts` (1 case)
- `apps/dashboard/test/auth-vs-static-order.e2e.test.ts` (2 cases)
- `apps/dashboard/package.json` (add `test:budget` script)
- `docs/phase-6-results.md`

### 6.7.1 — E2E flows

Reuses `bootServer`, `readUntil`, `parseSseFrames` from `apps/server/test/helpers.ts` (copy or symlink; do not duplicate).

`cookie-login.e2e.test.ts` (4): `POST /auth/login` with correct token returns 204 + `Set-Cookie: cognit_session=…; HttpOnly; SameSite=Strict; Path=/`; subsequent `GET /sessions/:id/events` round-trips cookie and returns 200; wrong token → 401; `GET /health` still 200 with no cookie.

`sse-live.e2e.test.ts` (3): `GET /events/stream` returns 200 + `content-type: text/event-stream`; `POST /events` causes a new frame to arrive within 1000ms; reconnect with `Last-Event-ID: <id>` replays only newer events.

`static-serve.e2e.test.ts` (1): after `vite build`, `apps/dashboard/dist/index.html` exists; `bootServer()` + `GET /` returns 200, `content-type: text/html`, body contains `<div id="root">`; `GET /assets/index-*.js` returns 200.

`auth-vs-static-order.e2e.test.ts` (2): `POST /auth/login` not shadowed by `app.get("*", serveStatic)` (regression guard); `GET /auth/login` returns the HTML form, not `index.html`.

### 6.7.2 — Build-size budget

Add to `apps/dashboard/package.json`:
```json
"test:budget": "node -e \"const fs=require('fs'),zlib=require('zlib');const dir='dist/assets';const files=fs.readdirSync(dir).filter(f=>f.endsWith('.js'));let total=0;for(const f of files){total+=zlib.gzipSync(fs.readFileSync(dir+'/'+f)).length;}if(total>250000){console.error('Bundle '+total+' bytes exceeds 250KB budget');process.exit(1);}console.log('Bundle '+total+' bytes OK');\""
```

(250KB gzip is a soft budget for v0.1; revisit in v0.2 if graph page bloats.)

### 6.7.3 — Results doc

`docs/phase-6-results.md` sections:
- **Test count delta** (table: phase 5 → 6).
- **New files** (list with one-line description).
- **Bug fixes shipped**.
- **AC closure** (tick or cross for the v0.1 success criterion).
- **Out of phase 6** (deferred: Recovery Center full block, Settings editor, session-scoped SSE).
- **Risks tracked but not exercised** (cross-browser, a11y, mobile).

### 6.7.4 — Final gate

```bash
npx turbo run test --force          # green across all new test files
npx turbo run typecheck             # green
npx turbo run lint                  # green
pnpm --filter @cognit/dashboard build && pnpm --filter @cognit/dashboard test:budget
```

Test count: project total ≥ 506 cases / 65 files (was 470/56 after phase 5).

---

## File ownership matrix (for parallel worktrees)

| Worktree | Touches | No-touch contract |
|---|---|---|
| 6.1 | `apps/dashboard/{index.html,vite.config.ts,tsconfig.json,package.json}`, `apps/dashboard/src/{main,App,router,index.css,lib/*,components/ui/*,components/{AppShell,NavBar},pages/Login}.tsx`, `apps/dashboard/test/{api-client,use-event-source,Login}.test.ts(x)` | No edits to `apps/dashboard/src/pages/{Overview,Timeline,KnowledgeGraph,DecisionGraph,Verification,Settings,RecoveryCenter}.tsx` |
| 6.2 | `apps/dashboard/src/pages/Overview.tsx`, `apps/dashboard/src/components/{ProjectCard,NewProjectDialog}.tsx`, `apps/dashboard/test/Overview.test.tsx` | No edits to `AppShell`, `router`, or other pages |
| 6.3 | `apps/dashboard/src/pages/Timeline.tsx`, `apps/dashboard/src/components/{TimelineList,EventRow,FilterBar,PauseSseButton}.tsx`, `apps/dashboard/test/Timeline.test.tsx` | No edits to `Overview` or `KnowledgeGraph` |
| 6.4 | `apps/dashboard/src/pages/KnowledgeGraph.tsx`, `apps/dashboard/src/components/{GraphCanvas,GraphControls,NodeSidePanel}.tsx`, `apps/dashboard/src/lib/{force-simulation,node-colors}.ts`, `apps/dashboard/test/KnowledgeGraph.test.tsx` | No edits to `Overview` or `Timeline` |
| 6.5 | `apps/dashboard/src/pages/{DecisionGraph,Verification}.tsx`, `apps/dashboard/src/components/{DecisionList,VerificationList,RerunButton,CancelButton}.tsx`, 2 test files | No edits to other pages |
| 6.6 | `apps/dashboard/src/pages/{Settings,RecoveryCenter}.tsx`, `apps/dashboard/src/components/{ConfigView,StorageUsage}.tsx`, 2 test files | No edits to other pages |
| 6.7 | NEW E2E files, `apps/dashboard/package.json` (build:budget), `docs/phase-6-results.md` | Reads only; no production edits |

**Disjoint files ⇒ safe to merge in any order after 6.1.**

## Test plan

| File | Cases | Notes |
|---|---|---|
| `apps/dashboard/test/api-client.test.ts` (NEW) | 6 | URL prefix, credentials, envelope unwrap, api_error surface, network error, AbortSignal |
| `apps/dashboard/test/use-event-source.test.ts` (NEW) | 5 | mount, unmount, lastEventId, backoff cap, frame parse |
| `apps/dashboard/test/Login.test.tsx` (NEW) | 3 | render, submit POST, navigate on 204 |
| `apps/dashboard/test/Overview.test.tsx` (NEW) | 4 | empty, list, click navigate, new project submit |
| `apps/dashboard/test/Timeline.test.tsx` (NEW) | 5 | initial 50, type chip, actor debounce, pause SSE, append without remount |
| `apps/dashboard/test/KnowledgeGraph.test.tsx` (NEW) | 4 | nodes+edges, physics, constellation, node click panel |
| `apps/dashboard/test/DecisionGraph.test.tsx` (NEW) | 3 | accepted+rejected, based_on link, superseded chain |
| `apps/dashboard/test/Verification.test.tsx` (NEW) | 3 | group by linked_hypothesis, rerun POST, cancel POST + disabled on terminal |
| `apps/dashboard/test/Settings.test.tsx` (NEW) | 2 | masked config, storage usage counts |
| `apps/dashboard/test/RecoveryCenter.test.tsx` (NEW) | 1 | "v0.2" badge |
| `apps/dashboard/test/cookie-login.e2e.test.ts` (NEW, E2E) | 4 | login + cookie round-trip, wrong token 401, /health 200 no cookie |
| `apps/dashboard/test/sse-live.e2e.test.ts` (NEW, E2E) | 3 | stream connect, post→frame, Last-Event-ID replay |
| `apps/dashboard/test/static-serve.e2e.test.ts` (NEW, E2E) | 1 | build → serveStatic → curl `/` |
| `apps/dashboard/test/auth-vs-static-order.e2e.test.ts` (NEW, E2E) | 2 | POST /auth/login not shadowed, GET /auth/login returns form not index.html |

**36 unit + 4 E2E (10 assertions) = 46 cases / 14 files** in `@cognit/dashboard`. Project total **~516 / 70**.

### Test plan acceptance

- **PASS when** every file in the table above lands with its case count, and `npx turbo run test --force` is green.
- **PASS when** `static-serve.e2e.test.ts` covers build → serveStatic → curl `/`.
- **PASS when** `auth-vs-static-order.e2e.test.ts` confirms the GET catch-all does not shadow `/auth/login`.
- **PASS when** `docs/phase-6-results.md` is written, test count delta reported, and `apps/dashboard` build script is real + under 250KB gzip budget.

### Coverage gaps (deferred to v0.2)

- Recovery Center full block (fuzzy search, related_sessions, suggested_next_steps).
- Settings redaction-patterns editor + export/import buttons.
- Session-scoped SSE (`GET /sessions/:id/events/stream`).
- Accessibility audit (axe-core) — only basic role/label in v0.1.
- Cross-browser (Safari, Firefox) — Chromium only in v0.1.
- Mobile breakpoints.
- Logout endpoint.

## Parallelism

- **6.1 must land first** (scaffold + dev proxy + login). 1 worktree, 1 PR.
- **6.2 + 6.3 + 6.4 + 6.5 + 6.6** independent (disjoint files). 5 parallel worktrees after 6.1.
- **6.7** runs last.

**Wall-clock:** 6.1 (~1 day) + max(6.2..6.6) (~1 day each) + 6.7 (~half day) = **~3.5 days**.

## Risks

| # | Rank | Risk | Mitigation |
|---|---|---|---|
| 1 | P0 | `app.get("*", serveStatic)` could shadow `GET /auth/login` form page in a future Hono upgrade. | `auth-vs-static-order.e2e.test.ts` is a regression guard. Mount order documented; PR-review checklist: any new wildcard route goes **before** `serveStatic`. |
| 2 | P0 | `EventSource` reconnect / `Last-Event-ID` plumbing is easy to break silently. | `use-event-source.test.ts` asserts `event.lastEventId` plumbing; `sse-live.e2e.test.ts` asserts reconnect semantics against a real server. |
| 3 | P1 | xyflow bundle size blows 250KB budget. | `@xyflow/react` v12 core is ~120KB gzip. Code-split Knowledge Graph + Decision Graph via `React.lazy`; measure in `test:budget`. If over, fall back to d3-force + SVG (hand-roll). |
| 4 | P1 | Physics simulation perf on large graphs. | Cap visible nodes at 500; auto-switch to constellation above 200 nodes. |
| 5 | P1 | `SameSite=Strict` cookie + dev proxy on :5173 → :6971. | `vite.config.ts` ships `server.proxy = { "/": "http://127.0.0.1:6971" }`; document in `vite.config.ts:1` header comment. |
| 6 | P2 | React 19 strict mode double-render artifacts in tests. | Wrap tests in `<App />` without `StrictMode`; dev only. |
| 7 | P2 | `vite build` `base: "./"` misconfigured → 404 on hashed assets. | `static-serve.e2e.test.ts` parses `index.html` for hashed asset name and `curl`s it. |

## Out of phase 6 scope

- Recovery Center full block (v0.2).
- Settings redaction editor + export/import buttons (v0.2).
- Session-scoped SSE (v0.2).
- Dashboard on separate port (`:6970`); we ship same-origin `:6971`.
- WebSocket fallback for SSE.
- Authentication: token rotation, logout endpoint, multi-user ACL.
- Dashboard write paths (most are read-only; mutations limited to "new project", "rerun", "cancel").

## Files to be created or modified

**NEW**

- `plans/phase-6.md` (this file)
- `apps/dashboard/index.html`
- `apps/dashboard/vite.config.ts`
- `apps/dashboard/src/main.tsx`
- `apps/dashboard/src/App.tsx`
- `apps/dashboard/src/router.tsx`
- `apps/dashboard/src/index.css`
- `apps/dashboard/src/lib/{api-client,use-api,use-event-source,format,force-simulation,node-colors}.ts`
- `apps/dashboard/src/components/ui/*` (shadcn copy: Button, Card, Input, Select, Badge, Tabs, Dialog, Tooltip)
- `apps/dashboard/src/components/{AppShell,NavBar,ProjectCard,NewProjectDialog,TimelineList,EventRow,FilterBar,PauseSseButton,GraphCanvas,GraphControls,NodeSidePanel,DecisionList,VerificationList,RerunButton,CancelButton,ConfigView,StorageUsage}.tsx`
- `apps/dashboard/src/pages/{Login,Overview,Timeline,KnowledgeGraph,DecisionGraph,Verification,Settings,RecoveryCenter}.tsx`
- `apps/dashboard/test/setup.ts`
- 10 unit test files (see test plan)
- 4 E2E test files (see test plan)
- `docs/phase-6-results.md`

**MODIFIED**

- `apps/dashboard/package.json` (real `build`, add `dev`, `preview`, `test:budget`, deps)
- `apps/dashboard/tsconfig.json` (add `jsx`, `types`)
- `pnpm-lock.yaml` (auto from `pnpm install`)
