# Architecture

Cognit is a local-first cognition layer for AI-assisted engineering. This page
gives a one-screen view of how the moving parts fit together; each subsystem is
documented in its own file under `docs/technical/`.

## Top-level layout

The repo is a pnpm + Turbo monorepo (`pnpm-workspace.yaml`, `turbo.json`) with
three working surfaces and one shared core:

- `apps/cli` — the `cognit` command (Commander program in
  `apps/cli/src/index.ts:1`). Every subcommand (`init`, `session`, `ask`,
  `agent`, `dashboard`, …) lives in `apps/cli/src/commands/`. The CLI writes
  the append-only event log via `packages/db` and reads back the folded state
  via `packages/core`.
- `apps/server` — a Hono HTTP server bound to loopback by default. Spawned by
  `cognit server` (`apps/cli/src/commands/server.ts`). It shares the project's
  `.cognit/cognit.db` SQLite file with the CLI, so both processes read the same
  event log.
- `apps/dashboard` — a Vite + React SPA (Feature-Sliced Design). Route table
  in `apps/dashboard/src/app/router.tsx:45`. Talks to the Hono server over
  loopback; no auth, no remote surface.
- `packages/` — headless libraries consumed by the three apps:
  - `packages/db` — SQLite event store, services, schema, migrations
    (`packages/db/src/schema/tables.ts`). Payload lifts go through
    `migratePayload` (`packages/db/src/migrate.ts`); production transforms
    are currently identity — see [events.md](./events.md).
  - `packages/core` — pure reducer (`packages/core/src/reducer.ts`), config
    schema, state-machine types. Golden replay fixtures under
    `packages/core/fixtures/golden/` gate reducer changes.
  - `packages/gravity` — pure 5-axis hypothesis ranking
    (`rankHypotheses` + axis helpers). The server re-exports this scorer
    (`apps/server/src/gravity-inputs.ts`); do not fork the formula in routes.
  - `packages/agent`, `packages/llm`, `packages/recovery`,
    `packages/verification`, `packages/wrap` — feature services layered on top
    of `db` + `core`.

There is no `packages/sdk` (removed) and no `packages/cli` (CLI is `apps/cli`).

There is no top-level `plugins/` directory; the integration points live in two
places instead:

- `apps/cli/src/commands/wrap.ts` — `cognit wrap -- <cmd>` runs a worker
  command and translates its output into inbox envelopes.
- `hooks/` (repo root) — reference hook scripts that publish inbox JSON
  envelopes for external CLIs (Claude Code, Codex, OpenCode, Gemini CLI).
  These are explained in `docs/hooks/README.md`.

## Data flow

```
┌─────────────────┐    JSON envelope    ┌──────────────────┐
│ external CLI /  │ ──────────────────▶ │ .cognit/inbox/   │
│ hook script     │   (atomic rename)   │  + processed/    │
└─────────────────┘                     │  + _error/       │
                                        └─────────┬────────┘
                                                  │ inbox sidecar
                                                  ▼
┌─────────────────┐  append event    ┌──────────────────┐  fold events  ┌──────────────────┐
│ cognit <cmd>    │ ───────────────▶ │ packages/db      │ ────────────▶ │ packages/core    │
│ (cli / ask /    │                  │ event store      │               │ SessionState     │
│  agent / wrap)  │ ◀─────────────── │ (cognit.db)      │ ◀──────────── │ (reducer.ts)     │
└─────────────────┘  SessionState    └──────────────────┘  SessionState └─────────┬────────┘
                                                                                  │
                                                              ┌───────────────────┼───────────────┐
                                                              ▼                   ▼               ▼
                                                    ┌───────────────┐   ┌────────────────┐  ┌──────────────────┐
                                                    │ apps/server   │   │ apps/dashboard │  │ cognit recovery  │
                                                    │ (Hono, JSON)  │   │ (Vite SPA)     │  │ / --json output  │
                                                    └───────────────┘   └────────────────┘  └──────────────────┘
```

The arrows collapse into one sentence: events are written once via
`SessionService.appendEvent`; the same event log is folded into state by the
pure reducer in `packages/core/src/reducer.ts`; the folded state is what the
dashboard, server, and CLI all read back.

## Subsystem docs

- [data-model.md](./data-model.md) — tables, events, reducer.
- [configuration.md](./configuration.md) — `cognit.yaml` schema.
- [storage.md](./storage.md) — SQLite file + `.cognit/` directory.
- [cli.md](../cli.md) — CLI subcommand reference.
- [dashboard.md](../dashboard.md) — dashboard route reference.
- [hooks/README.md](../hooks/README.md) — how external CLIs publish to Cognit.