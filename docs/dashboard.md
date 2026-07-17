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
| 2 | `/timeline`          | `<TimelinePage />`           | Chronological **domain** event timeline. Event sheet tabs: **Summary** (truncated payload) \| **Raw evidence** (lazy `GET /api/events/:id/raw` — tool/path/diff; D-M6-00 dual store). |
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

Host-only. No Docker.

```bash
cd /path/to/your-repo   # after cognit init
cognit dashboard --no-open
# UI  http://127.0.0.1:6970
# API http://127.0.0.1:6971  (auto-started for this root's .cognit/)
```

| Port | Role |
|------|------|
| 6970 | Vite UI |
| 6971 | Hono API bound to the root you started from |

`cognit dashboard` spawns both processes. Change directory (or pass
`--root`) to view another project's memory.

## Timeline detail (D-M6-00)

Opening a domain event on `/timeline` shows a side sheet with two tabs:

| Tab | Source | Content |
|-----|--------|---------|
| **Summary** | List payload (domain `events` row) | When, actor, semantic family, truncated domain payload / evidence summary |
| **Raw evidence** | `GET /api/events/:id/raw` (lazy on tab select) | Full redacted wire envelope from `raw_events` — tool, path, `old_string`/`new_string` when present, tool_response, collapsible JSON. 404 empty state for pre-M6 / non-tool events |

Domain list still hides transport noise (`raw_tool_signal` as a domain kind is not emitted after D-M5/M6 classify). Soft link: `events.correlation_id` → `raw_events.id`.

