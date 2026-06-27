# Dashboard

The dashboard is a Vite + React SPA (Feature-Sliced Design). It runs on
demand via `cognit dashboard` (see `docs/cli.md` and
`apps/cli/src/commands/dashboard.ts:1`) and talks to the local Hono server
over loopback. There is no auth — every route renders inside `<AppShell>`,
which provides the nav + content outlet (`apps/dashboard/src/app/router.tsx:13`).

## Routes

The route table is declared in `apps/dashboard/src/app/router.tsx:45-60`.
Pages live under `apps/dashboard/src/pages/` (FSD "pages" layer — one per
route). Two pages are lazy-loaded via `React.lazy` so their bundle is fetched
only when the route is visited: Recovery Center
(`router.tsx:28-30`, `recovery-center.tsx`) and Rules
(`router.tsx:32-34`, `rules.tsx`). A catch-all `*` redirects to `/`.

| # | Path                 | Component (router.tsx:50-58) | One-line purpose                                                                  |
|---|----------------------|------------------------------|-----------------------------------------------------------------------------------|
| 1 | `/`                  | `<OverviewPage />`           | Project overview: counts, recent activity, current session summary.               |
| 2 | `/timeline`          | `<TimelinePage />`           | Chronological event timeline for the active session.                              |
| 3 | `/knowledge-graph`   | `<KnowledgeGraphPage />`     | Knowledge graph view of entities + edges (uses `edges` table from data-model).    |
| 4 | `/decision-graph`    | `<DecisionGraphPage />`      | Decision graph: proposes → accepts / rejects / supersedes over time.              |
| 5 | `/verification`      | `<VerificationPage />`       | Verification runs and their pass/fail/error lifecycle.                            |
| 6 | `/ai-reasoning`      | `<AiReasoningPage />`        | AI reasoning traces (hypotheses, experiments, conclusions) for the session.       |
| 7 | `/recovery-center`   | `lazy(RecoveryCenterPage)`   | Recovery: search sessions, fork closed ones, inspect v0.2 envelopes.              |
| 8 | `/rules`             | `lazy(RulesPage)`            | Manage constraint rules (CRUD over `constraint_rules` table).                      |
| 9 | `/settings`          | `<SettingsPage />`           | Project + LLM gateway settings (mirrors `cognit.yaml → llm.*` and `cleanup.*`).    |

The catch-all `<Navigate to="/" replace />` at `router.tsx:59` sends
unmatched paths back to the overview.

## Loading + fallback

Lazy routes are wrapped in `withSuspense` (`router.tsx:43`), which renders a
`Skeleton` placeholder (`router.tsx:36-41`) while the chunk is fetched. Vite
splits each lazy page into its own bundle so the initial route payload stays
small (see the file header at `router.tsx:1`).

## Default URL

The dashboard has three distinct addresses depending on which surface
runs where. The mnemonic is "API = 6971; Vite dev = 5173; docker
publish = 6970".

| Surface                  | Binds to                | URL you open                                  |
|--------------------------|-------------------------|-----------------------------------------------|
| Hono API server          | `127.0.0.1:6971`        | (internal — dashboard fetches from here)     |
| Vite dev dashboard       | `127.0.0.1:5173`        | `http://localhost:5173`                       |
| Docker-published dashboard | host `:6970` (publish) | `http://localhost:6970`                       |

**Local dev (`cognit dashboard`).** `cognit dashboard` spawns two
processes:

- the Hono API in `apps/server`, bound to `127.0.0.1:6971`
  (`apps/server/src/config.ts:29` — the canonical API endpoint);
- the Vite dev server in `apps/dashboard`, bound to `127.0.0.1:5173`
  (`apps/dashboard/vite.config.ts`). The Vite dev server proxies API
  requests to `127.0.0.1:6971`, so you open
  `http://localhost:5173` in the browser and do not need to think
  about the Hono port.

**Docker profile (`cognit dashboard --docker`).** Runs the dashboard
+ Hono inside a container. The container's Hono still binds
`127.0.0.1:6971` internally; the docker port mapping publishes it on
host `:6970` (see `apps/cli/src/commands/dashboard.ts:104`). You open
`http://localhost:6970` — that is the **docker-published** address,
not a loopback bind inside the container.

If you see `http://localhost:6971` referenced in older docs, treat it
as the Hono API endpoint, not the dashboard URL.