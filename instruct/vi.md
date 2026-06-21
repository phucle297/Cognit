# Cognit — Hướng dẫn sử dụng

## Cognit là gì

Local-first persistent decision + knowledge layer cho AI-assisted engineering. Ghi lại **reasoning** (observation, hypothesis, experiment, conclusion, decision, verification), không ghi chat. Tương tự Git cho code, Cognit cho cognition.

Khẩu hiệu: *Code có Git. Task có Jira. AI có Cognit.*

Stack: Node 24 + pnpm 9 + Turborepo + TypeScript 5.5 (ESM) + Effect (validation + FP runtime) + Drizzle + better-sqlite3 + Hono server + React 19 + Vite dashboard.

---

## Cài đặt

```bash
pnpm install
pnpm -F @cognit/cli build
```

Yêu cầu: Node ≥ 24, pnpm 9.

CLI binary entry (`apps/cli/package.json` `bin`) trỏ vào raw TypeScript (`./src/index.ts`), nên `pnpm link --global` từ `apps/cli/` không tạo được global `cognit` command chạy được. Hai cách chạy:

- **Workspace exec (không cần sửa):** từ repo root, `pnpm exec cognit <subcommand>` — workspace bin resolve `dist/index.js`.
- **Global `cognit` command:** sửa `apps/cli/package.json` thành `"bin": { "cognit": "./dist/index.js" }`, rồi `cd apps/cli && pnpm link --global`. Rebuild bằng `pnpm -F @cognit/cli build` sau mỗi lần đổi.

---

## Khởi tạo trong repo

```bash
cd your-project
cognit init
```

Tạo `.cognit/`:
- `cognit.db` — SQLite store
- `cognit.yaml` — config (commit file này)
- `inbox/` — worker event drop zone
- `artifacts/curated/`, `snapshots/`, `archive/`

Append `.cognit/.gitignore` snippet vào repo `.gitignore`. **Không** commit `.cognit/cognit.db`.

---

## Workflow chính (10 bước canonical)

```bash
# 1. Tạo session
cognit session create "Fix Next.js memory leak"

# 2. Observation
cognit observation add "Next.js reaches 18GB VmPeak during local dev"

# 3. Theory + hypothesis
cognit theory add "HMR resource retention"
cognit hypothesis add "Turbopack cache is leaking memory" \
  --belongs-to "HMR resource retention" --confidence 0.7

# 4. Experiment test hypothesis
cognit experiment add "Disable Turbopack and measure memory growth" \
  --tests "Turbopack cache is leaking memory"

# 5. Hoàn thành experiment
cognit experiment complete \
  --result "Memory still increases after disabling Turbopack" \
  --contradicts "Turbopack cache is leaking memory"

# 6. Reject hypothesis (typed reason)
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

## Resume investigation (sau này)

```bash
cognit session resume "Fix Next.js memory leak"
```

Output: rejected hypotheses, verified conclusions, accepted decisions, last known state, **suggested next step** (từ Gravity Engine v0.2 — rank active hypotheses theo evidence + reproducibility + confidence + actor trust + freshness decay).

`--fork=false` để append vào session cũ. `--id <ulid>` để chọn session chính xác.

---

## Worker Inbox Adapter (capture từ AI tool)

Mọi worker (Claude Code, Codex, OpenCode, Gemini CLI, script) publish event bằng cách ghi JSON file vào `.cognit/inbox/<session-id>-<ulid>.json`. Watcher (chokidar) đọc, validate Effect Schema, redact secrets, append vào store qua single boundary `appendEvent`.

**Atomic write protocol** (partial write không bị pick up):
1. Write `<file>.tmp`
2. `fsync`
3. Rename `<file>.json`

`packages/wrap/src/atomic-write.ts` enforce — dùng helper này thay vì tự roll.

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

Unknown actor → auto-register với default trust từ `cognit.yaml` + emit `actor_registered`.

### Auto-capture với `cognit wrap`

```bash
cognit wrap -- claude-code --print "Investigate the memory leak"
```

Capture tool calls + exit codes + stderr lines thành observations tự động.

### Hooks cho từng worker

`docs/hooks/` có hướng dẫn cho:
- claude-code (`.claude/settings.json`)
- codex
- opencode
- gemini-cli

Ví dụ Claude Code:
```json
{
  "hooks": {
    "PostToolUse": "cognit observation add",
    "PreToolUse": "cognit hypothesis add"
  }
}
```

---

## AI-Driven Gravity Rank (v1.2.0)

AI supervisor (`packages/agent/`) đọc session state + recovery envelope → gọi LLM (qua Vercel AI SDK, multi-provider) → emit event `hypothesis_ranked`:

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

Reducer lưu rank mới nhất vào `HypothesisState.ai_rank_*`. Gravity engine dùng `ai_rank_score` nếu có, fallback về formula cho hypothesis chưa được AI rank.

---

## Inspection (không cần dashboard)

```bash
# Event stream với filter + follow
cognit events --session <id> --type verification_failed --follow

# Full session audit
cognit session show <id-or-goal>
```

`--follow` poll SQLite trực tiếp, không cần server.

---

## Secret Redaction

Mọi event scan secret patterns tại ingest. Built-in: JWT, `key=`/`api_key=`/`token=`, PEM blocks, password fields. Custom trong `cognit.yaml`. Plaintext **không bao giờ** vào disk.

> Redaction at ingest, không retroactive. Secret leak cũ → restore từ `cognit export` trước đó + re-import.

---

## Export / Import

```bash
cognit export --output investigation-2026-06-12.tar.gz --include-artifacts
cognit import --input investigation-2026-06-12.tar.gz --merge-strategy skip
```

Bundle: `manifest.json` + `cognit.yaml` + SQLite dump (VACUUM INTO) + `artifacts/`.

Merge strategies: `skip` (default, safe), `overwrite`, `fork` (rewrite id + remap FK).

---

## Config (cognit.yaml)

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

## Dashboard (port 6970)

Pages: Overview, Timeline, Knowledge Graph (React Flow), Decision Graph, Verification, Recovery Center, Settings.

```bash
cognit dashboard
```

Hoặc Docker (full stack):
```bash
docker compose up -d
open http://localhost:6970
```

Chỉ port `:6970` (UI) exposed. `:6971` (API) loopback-only hoặc internal docker network.

---

## Architecture tóm tắt

**Event sourcing**: state rebuild bằng replay event stream. Snapshots tăng tốc. Append-only events, append-only snapshots.

**Domain model**:
- Session → Observations, Findings, Hypotheses (lifecycle: active → weakened | rejected | promoted), Theories, Experiments, Decisions, Conclusions, Verifications (lifecycle: started → passed | failed | errored | cancelled; rerun-able), Edges, Snapshots
- Edges typed: `tests`, `supports`, `contradicts`, `supersedes`, `caused`, `based_on`, `verified_by`, `belongs_to`, `derived_from`, `references`

**Engines**:
- **Gravity** — weighted sum score cho open hypothesis. Recovery uses top-1.
- **Constraint** — JSON rule engine. Fire trên `experiment_completed` + `verification_failed`. Actions: `reject_hypothesis`, `weaken_hypothesis`, `promote_hypothesis`, `create_finding`.

**Packages layout**:
- `packages/core` — pure data + functions (entity models, reducer; no class)
- `packages/db` — store + event bus + redaction + migrations + inbox sidecar
- `packages/gravity` — scoring
- `packages/verification` — spawn-based verify lifecycle
- `packages/wrap` — atomic-write helper + CLI shim
- `packages/sdk` — client SDK
- `packages/recovery` — session resume context
- `packages/agent` — AI supervisor (đọc local store, gọi LLM qua Vercel AI SDK, apply decisions + rank overrides; emit event `hypothesis_ranked` với `override_rule_based: true` khi cần)
- `apps/cli` — binary `cognit` (Commander.js; tsup build → `dist/index.js`)
- `apps/server` — Hono API trên `:6971`
- `apps/dashboard` — React 19 + Vite UI trên `:6970`

**Auth**: không có. Local-only tool. Loopback boundary = security guarantee.

---

## Development

```bash
pnpm dev:server      # Hono API
pnpm dev:dashboard   # Vite UI
pnpm dev:cli         # tsx CLI
pnpm check           # typecheck + lint + test
```

Toolchain: oxlint (lint), oxfmt (format), Vitest (test), `tsc --noEmit` (type-check). Tất cả Rust-native (oxc).

**Hard rules** (theo `CONVENTIONS.md`):
- No `throw` trong `packages/*` — Effect error channels hoặc typed `Result`
- No `any` — dùng `unknown` + narrowing
- No class-based domain models trong `core`
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

`--json <command>` envelope stable (`{version:1, kind, data}`) cho mọi command. `--session` sticky từ `current-session` pointer trừ khi override.

---

## Đọc thêm

- **Conceptual** (state model, event sourcing, edges, lifecycle) — `README.md`
- **Architecture** (services, layers, migrations, runtime) — `ARCHITECTURE.md`
- **Stack** (deps, why-not-X list) — `STACK.md`
- **Conventions** (naming, layout, anti-patterns) — `CONVENTIONS.md`
- **Plan** (spec, data model, AC per phase) — `plan.xml`
- **Worker hooks** (claude-code, codex, opencode, gemini-cli) — `docs/hooks/`
- **Per-package API** — đọc `packages/<pkg>/src/index.ts` (convention: re-export mọi public surface)

Issue tracking: `bd` (beads) — Dolt-backed local DB + git-remote sync.
