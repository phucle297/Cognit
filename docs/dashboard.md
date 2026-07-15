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

Simple port model (local-first):

| Surface | Host URL | Notes |
|---------|----------|--------|
| Hono API | `http://127.0.0.1:6971` | `docker compose up -d` publishes it; or `cognit server` |
| Dashboard UI | `http://127.0.0.1:6970` | `cognit dashboard` (vite) or `--docker` (nginx SPA) |

**Normal flow**

```bash
# In the Cognit repo (once)
docker compose up -d          # API on 127.0.0.1:6971

# Anywhere (global CLI link)
cognit dashboard              # UI on 127.0.0.1:6970 → proxies /api to :6971
```

Vite proxies `/api/*` to `http://127.0.0.1:6971`. The browser only
talks to `:6970`; you never need to open `:6971` in a browser tab.

**Docker SPA (`cognit dashboard --docker`).** Optional nginx image on
the same host port `:6970`, proxying `/api/*` to the `server` service
on the compose network (or to host-published `:6971` when using the
host vite path above).