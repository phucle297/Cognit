# Cognit — User Guide

## What is Cognit

Local-first persistent decision + knowledge layer for AI-assisted engineering. Records **reasoning** (observations, hypotheses, experiments, conclusions, decisions, verifications), not chat. Like Git for code, Cognit for cognition.

Tagline: *Code has Git. Tasks have Jira. AI has Cognit.*

Stack: Node 24 + pnpm 9 + Turborepo + TypeScript 5.5 (ESM) + Effect (validation + FP runtime) + Drizzle + better-sqlite3 + Hono server + React 19 + Vite dashboard.

---

## Install

```bash
pnpm install
pnpm -F @cognit/cli build
```

Requires Node ≥ 24, pnpm 9.

The CLI binary entry (`apps/cli/package.json` `bin`) points at raw TypeScript (`./src/index.ts`), so `pnpm link --global` from `apps/cli/` does not produce a runnable global `cognit` command on its own. Two ways to run it:

- **Workspace exec (no edits):** from the repo root, `pnpm exec cognit <subcommand>` — the workspace bin resolves `dist/index.js`.
- **Global `cognit` command:** edit `apps/cli/package.json` so `"bin": { "cognit": "./dist/index.js" }`, then `cd apps/cli && pnpm link --global`. Rebuild with `pnpm -F @cognit/cli build` after each change.

---

## Initialize in a repo

```bash
cd your-project
cognit init
```

Creates `.cognit/`:
- `cognit.db` — SQLite store
- `cognit.yaml` — config (commit this file)
- `inbox/` — worker event drop zone
- `artifacts/curated/`, `snapshots/`, `archive/`

Append the `.cognit/.gitignore` snippet to your repo's `.gitignore`. Do **not** commit `.cognit/cognit.db`.

---

## Canonical workflow (10 steps)

```bash
# 1. Create session
cognit session create "Fix Next.js memory leak"

# 2. Observation
cognit observation add "Next.js reaches 18GB VmPeak during local dev"

# 3. Theory + hypothesis
cognit theory add "HMR resource retention"
cognit hypothesis add "Turbopack cache is leaking memory" \
  --belongs-to "HMR resource retention" --confidence 0.7

# 4. Experiment tests hypothesis
cognit experiment add "Disable Turbopack and measure memory growth" \
  --tests "Turbopack cache is leaking memory"

# 5. Complete experiment
cognit experiment complete \
  --result "Memory still increases after disabling Turbopack" \
  --contradicts "Turbopack cache is leaking memory"

# 6. Reject hypothesis with typed reason
cognit hypothesis reject "Turbopack cache is leaking memory" \
  --reason "Disabling Turbopack did not stop memory growth" \
  --reason-type evidence

# 7. New hypothesis + verification
cognit hypothesis add "Module graph listener leak in HMR" \
  --belongs-to "HMR resource retention" --confidence 0.6

cognit verify --type benchmark --command "pnpm run bench:memory" \
  --tests "Module graph listener leak in HMR"

# 8. Conclusion + verify
cognit conclusion propose "Memory leak is in the HMR module graph"
cognit conclusion verify <conclusion-id> --with <verification-id>

# 9. Decision
cognit decision accept "Disable HMR module caching in CI" \
  --reason "Memory leak source is the module graph" \
  --based-on <conclusion-id>

# 10. Dashboard
cognit dashboard
# → http://localhost:6970
```

---

## Resume an investigation

```bash
cognit session resume "Fix Next.js memory leak"
```

Output: rejected hypotheses, verified conclusions, accepted decisions, last known state, **suggested next step** (from Gravity Engine v0.2 — ranks active hypotheses by evidence + reproducibility + confidence + actor trust + freshness decay).

`--fork=false` to append into the existing session. `--id <ulid>` to pick a specific session.

---

## Worker Inbox Adapter (capture from AI tools)

Any worker (Claude Code, Codex, OpenCode, Gemini CLI, custom script) publishes events by writing JSON files into `.cognit/inbox/<session-id>-<ulid>.json`. The watcher (chokidar) reads, validates Effect Schema, redacts secrets, appends to the store via the single boundary `appendEvent`.

**Atomic write protocol** (so partial writes are not picked up):
1. Write `<file>.tmp`
2. `fsync`
3. Rename `<file>.json`

`packages/wrap/src/atomic-write.ts` enforces this — use the helper, do not roll your own.

### Event envelope example

```json
{
  "schema_version": "1.0.0",
  "type": "hypothesis_created",
  "session_id": "01HXY...",
  "actor": { "type": "worker", "name": "claude-code" },
  "source": { "tool": "cognit", "command": "cognit hypothesis add ..." },
  "payload": { "title": "Runtime listener leak" },
  "confidence": 0.72
}
```

Unknown actor → auto-register with default trust from `cognit.yaml` + emit `actor_registered`.

### Auto-capture with `cognit wrap`

```bash
cognit wrap -- claude-code --print "Investigate the memory leak"
```

Captures tool calls + exit codes + stderr lines as observations automatically.

### Hooks per worker

`docs/hooks/` has guides for:
- claude-code (`.claude/settings.json`)
- codex
- opencode
- gemini-cli

Example Claude Code hook:
```json
{
  "hooks": {
    "PostToolUse": "cognit observation add",
    "PreToolUse": "cognit hypothesis add"
  }
}
```

---

## Inspect without dashboard

```bash
# Event stream with filter + follow
cognit events --session <id> --type verification_failed --follow

# Full session audit
cognit session show <id-or-goal>
```

`--follow` polls SQLite directly — no API server needed.

---

## Secret redaction

Every event is scanned for secret patterns at ingest. Built-in: JWT, `key=`/`api_key=`/`token=`, PEM blocks, password fields. Custom patterns in `cognit.yaml`. Plaintext never reaches disk.

> Redaction is at ingest, not retroactive. Old secret leaks stay leaked — restore from an earlier `cognit export` and re-import.

---

## Export / Import

```bash
cognit export --output investigation-2026-06-12.tar.gz --include-artifacts
cognit import --input investigation-2026-06-12.tar.gz --merge-strategy skip
```

Bundle layout: `manifest.json` + `cognit.yaml` + SQLite dump (VACUUM INTO) + `artifacts/`.

Merge strategies: `skip` (default, safe), `overwrite`, `fork` (rewrite id + remap FK columns).

---

## Config (`cognit.yaml`)

```yaml
project:
  name: cognit

redaction:
  enabled: true
  patterns:
    - name: internal_bearer
      regex: "Bearer [A-Za-z0-9._-]{20,}"
      replacement: "Bearer [REDACTED]"

cleanup:
  artifact_max_age_days: 30
  unreferenced_action: archive   # archive | delete | keep
  max_db_size_mb: 1024

session:
  snapshot_every_n_events: 100
  fork_on_resume: true

actors:
  defaults:
    human: 0.9
    worker: 0.6
    system: 1.0
  known:
    - name: claude-code
      trust_score: 0.7

inbox:
  watch: true
  debounce_ms: 200
  atomic_write_required: true
```

Edit: `cognit config --edit`. Show: `cognit config --show`.

---

## AI-Driven Gravity Rank (v1.2.0)

The AI supervisor (`packages/agent/`) reads session state + the recovery envelope, calls an LLM (via Vercel AI SDK — multi-provider: Anthropic, OpenAI, Ollama, …), and emits `hypothesis_ranked` events:

```json
{
  "schema_version": "1.2.0",
  "type": "hypothesis_ranked",
  "session_id": "01HXY...",
  "payload": {
    "hypothesis_id": "01hyp...",
    "score": 0.72,
    "reasoning": "Strongest evidence + reproducible verification",
    "evaluator": "ai-supervisor",
    "override_rule_based": true,
    "context_event_ids": ["01obs...", "01exp..."]
  }
}
```

The reducer stores the latest rank on `HypothesisState.ai_rank_*`. The gravity engine uses `ai_rank_score` when present and falls back to the rule-based formula for hypotheses the AI has not evaluated yet — the two views stay comparable on the dashboard.

---

## Dashboard (port 6970)

Pages: Overview, Timeline, Knowledge Graph (React Flow), Decision Graph, Verification, Recovery Center, Settings.

```bash
cognit dashboard
```

Or Docker (full stack):
```bash
docker compose up -d
open http://localhost:6970
```

Only `:6970` (UI) is exposed. `:6971` (API) is loopback-only or internal docker network.

---

## Architecture summary

**Event sourcing**: rebuild state by replaying the event stream. Snapshots accelerate replay. Append-only events, append-only snapshots.

**Domain model**:
- Session → Observations, Findings, Hypotheses (lifecycle: active → weakened | rejected | promoted), Theories, Experiments, Decisions, Conclusions, Verifications (lifecycle: started → passed | failed | errored | cancelled; rerun-able), Edges, Snapshots
- Typed edges: `tests`, `supports`, `contradicts`, `supersedes`, `caused`, `based_on`, `verified_by`, `belongs_to`, `derived_from`, `references`

**Engines**:
- **Gravity** — weighted-sum score for open hypotheses. Recovery surfaces top-1.
- **Constraint** — JSON rule engine. Fires on `experiment_completed` and `verification_failed`. Actions: `reject_hypothesis`, `weaken_hypothesis`, `promote_hypothesis`, `create_finding`.

**Packages layout**:
- `packages/core` — pure data + functions (entity models, reducer; no classes)
- `packages/db` — store + event bus + redaction + migrations + inbox sidecar
- `packages/gravity` — scoring
- `packages/verification` — spawn-based verify lifecycle
- `packages/wrap` — atomic-write helper + CLI shim
- `packages/sdk` — client SDK
- `packages/recovery` — session resume context
- `packages/agent` — AI supervisor (forks from the local store, calls an LLM via the Vercel AI SDK, applies decisions + rank overrides; gates `hypothesis_ranked` events on `override_rule_based: true`)
- `apps/cli` — the `cognit` CLI binary (Commander.js; tsup build → `dist/index.js`)
- `apps/server` — Hono API on `:6971`
- `apps/dashboard` — React 19 + Vite UI on `:6970`

**Auth**: none. Local-only tool. Loopback boundary = security guarantee.

---

## Development

```bash
pnpm dev:server      # Hono API
pnpm dev:dashboard   # Vite UI
pnpm dev:cli         # tsx CLI
pnpm check           # typecheck + lint + test
```

Toolchain: oxlint (lint), oxfmt (format), Vitest (test), `tsc --noEmit` (type-check). All Rust-native (oxc).

**Hard rules** (per `CONVENTIONS.md`):
- No `throw` in `packages/*` — Effect error channels or typed `Result`
- No `any` — use `unknown` + narrowing
- No class-based domain models in `core`
- No global CSS — Tailwind 4 only
- No zod / yup / valibot — Effect Schema only
- No Prisma / TypeORM — Drizzle only
- No ESLint / Prettier — oxc only

---

## CLI cheat-sheet

```bash
# Lifecycle
cognit init
cognit session create "goal"
cognit session resume "goal"
cognit session show <id>
cognit session pause | close

# Capture
cognit observe "text" [--confidence 0..1]
cognit finding "text" [--related obs-id,obs-id]
cognit hypothesis add "title" [--confidence 0..1]
cognit hypothesis reject --id <h> --reason "..."
cognit experiment add "text" --tests <h-id>
cognit experiment complete --id <e> --result "..."
cognit decision accept --id <d> --reason "..." --based-on <c-id>
cognit conclusion propose "text"
cognit conclusion verify --id <c> --with <v-id>

# Verification
cognit verify --type benchmark --command "cmd" [--tests <h-id>]
cognit verify pass | fail | error | cancel --id <v>

# Edges + constraints
cognit edge add --from e:id --to e:id --kind supports
cognit constraint add --json '{"when":{...},"then":{...}}'

# Inspect
cognit events --session <id> --follow
cognit schema-dump

# Server / dashboard
cognit server [--host ip] [--port n]
cognit dashboard

# Bulk / portable
cognit export --output x.tar.gz [--include-artifacts]
cognit import --input x.tar.gz [--merge-strategy skip|overwrite|fork]
cognit gc [--dry-run] [--max-age-days N]
```

`--json <command>` emits a stable envelope (`{version:1, kind, data}`) for every command. `--session` reads from a sticky `current-session` pointer unless overridden.

---

## Deep dive

- **Conceptual** (state model, event sourcing, edges, lifecycle) — `README.md`
- **Architecture** (services, layers, migrations, runtime) — `ARCHITECTURE.md`
- **Stack** (deps, why-not-X list) — `STACK.md`
- **Conventions** (naming, layout, anti-patterns) — `CONVENTIONS.md`
- **Plan** (spec, data model, AC per phase) — `plan.xml`
- **Worker hooks** (claude-code, codex, opencode, gemini-cli) — `docs/hooks/`
- **Per-package API** — read `packages/<pkg>/src/index.ts` (convention: re-export all public surface)

Issue tracking: `bd` (beads) — Dolt-backed local DB + git-remote sync.
