# Cognit — User Guide

> **Git for AI cognition.**
> Code has Git. Tasks have Jira. AI has Cognit.

Cognit records what AI workers **learn**, **try**, **reject**, **verify**, and **conclude** during engineering work. State is permanent. Workers are temporary. You do not run investigations yourself — the **AI supervisor** drives hypothesis generation, ranking, and verification. You provide observations, run the supervisor, and steer when it goes off course.

---

## 1. What Cognit is (and isn't)

| Cognit is                         | Cognit is not             |
| --------------------------------- | ------------------------- |
| Persistent decision layer         | Chat history DB           |
| Typed knowledge graph             | Agent framework           |
| Event-sourced investigation store | Workflow engine           |
| Worker-agnostic inbox             | Backup tool               |
| **AI-supervisor-driven loop**     | Manual hypothesis tracker |

The supervisor (an AI worker) reads the session state, reasons about it, and emits structured events. **You** do not type hypotheses — the AI does. **You** review what it produced and steer when it goes off course.

---

## 2. Install

Requirements: **Node.js 24 LTS**, **pnpm 9**, **git**.

```bash
pnpm install
pnpm build
cd apps/cli/ && pnpm link --global
```

Verify:

```bash
cognit --version
cognit agent --help    # confirms the supervisor subcommand is wired
```

> Tip: workspace exec also works. From repo root: `pnpm exec cognit <subcommand>`.

---

## 3. Initialize in a repo

Inside the repository you want Cognit to track:

```bash
cd your-project
cognit init
```

Creates:

```text
.cognit/
├─ cognit.db      # SQLite store (source of truth)
├─ cognit.yaml    # project config
├─ .gitignore     # ignore rules for the store
├─ inbox/         # drop zone for AI worker events
├─ artifacts/     # evidence (logs, diffs, screenshots)
├─ snapshots/     # replay checkpoints
└─ archive/       # gc'd artifacts
```

Append to your repo `.gitignore`:

```gitignore
.cognit/cognit.db
.cognit/inbox/
.cognit/snapshots/
.cognit/archive/
.cognit/.gitignore
```

Commit `cognit.yaml` (your config). Commit curated artifacts selectively. **Do not** commit `cognit.db` — it's local-only state.

---

## 4. The AI-supervisor flow (canonical)

The canonical loop is **observation in, AI reasoning out**. You capture observations, the supervisor reads state and emits typed events, Gravity ranks by AI judgement, you review.

### 4.1 Start a session

```bash
cognit session create "Fix Next.js memory leak"
```

Prints the session id (ULID). Use `--session <id>` later for precision.

### 4.2 Capture observations

Either by wrapping a command:

```bash
cognit wrap -- pnpm run bench:memory
# stderr lines become observation_recorded events
# terminal exit produces verification_passed / verification_failed
```

Or directly:

```bash
cognit observation add "Next.js reaches 18GB VmPeak during local dev"
cognit observation add "Memory growth starts after HMR updates"
```

The observations land in the event store. They are the raw facts the supervisor reasons over.

### 4.3 Run the supervisor

```bash
# mock LLM (no API keys, deterministic canned decisions)
cognit agent run --session <id> --provider mock

# real provider — set the matching env var
export ANTHROPIC_API_KEY=...     # anthropic
# or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_KEY / OLLAMA_BASE_URL
cognit agent run --session <id> --provider anthropic --model claude-sonnet-4-6
cognit agent run --session <id> --provider openai    --model gpt-4o
cognit agent run --session <id> --provider google    --model gemini-2.5-pro
cognit agent run --session <id> --provider ollama    --model llama3.1

# one-shot: one tick then exit
cognit agent run --session <id> --once

# bounded run
cognit agent run --session <id> --max-ticks 5 --tick-interval-ms 2000
```

Each tick:

1. Tail events since the cursor.
2. Replay state via the reducer.
3. Build a prompt (capped at 50 hypotheses by default).
4. Call the LLM, parse the JSON into an `AgentDecision` schema.
5. Apply the decision (up to 5 actions per tick by default).
6. Emit `hypothesis_ranked` events that the Gravity Engine consumes.

SIGINT flips a flag the loop checks between ticks; a second SIGINT hard-exits.

### 4.4 Supervise from another terminal

```bash
cognit agent status --session <id>   # running, tick count, last tick id
cognit agent stop   --session <id>   # idempotent
```

### 4.5 Gravity ranks by AI scores

When the supervisor emits `hypothesis_ranked`, the **Gravity Engine** (v1.2.0) reads the AI score and uses it as the authoritative rank. The 5-axis rule-based score (evidence + reproducibility + confidence + actor trust + freshness decay) becomes the **fallback** for hypotheses the AI has not yet scored.

Each `RankedHypothesis` carries a `source: "ai" | "rule"` so you can tell which path produced the score.

### 4.6 Inspect the recovery surface

```bash
# full v0.2 recovery envelope for one session
cognit recovery <session-id>

# fuzzy search across sessions
cognit recovery search "memory leak"

# raw reducer output
cognit session show <id-or-goal>

# live-tail hypothesis ranks
cognit events --type hypothesis_ranked --follow
```

### 4.7 Steer the loop

When the top hypothesis is wrong, or you want the AI to look elsewhere:

- **Send a new observation** that nudges the AI.
- **Reject the AI's choice** by emitting a `hypothesis_rejected` event yourself (manual CLI is a debug tool here, not the main path).

---

## 5. Manual CLI as fallback (debug only)

Direct CLI commands still exist. Use them to inspect, patch, or seed state — not as the primary flow.

```bash
# seed a theory / hypothesis manually for testing
cognit theory add "HMR resource retention"
cognit hypothesis add "Turbopack cache is leaking memory" \
  --belongs-to "HMR resource retention" --confidence 0.7

# run an experiment manually
cognit experiment add "Disable Turbopack and measure memory growth" \
  --tests "Turbopack cache is leaking memory"
cognit experiment complete \
  --result "Memory still increases after disabling Turbopack" \
  --contradicts "Turbopack cache is leaking memory"

# reject a hypothesis with a typed reason
cognit hypothesis reject "Turbopack cache is leaking memory" \
  --reason "Disabling Turbopack did not stop memory growth" \
  --reason-type evidence
```

Use these for one-off debugging. The AI supervisor is the canonical writer of these events.

---

## 6. Wiring custom AI workers to Cognit

If you do not want to use the built-in `cognit agent run` loop, you can run your own LLM and feed events into the inbox. The supervisor contract is the `hypothesis_ranked` event.

### 6.1 `cognit wrap` shim

Wrap any command. stderr lines → `observation_recorded`. Exit code → `verification_passed` / `_failed` / `_errored`.

```bash
cognit wrap -- claude-code --print "Investigate the memory leak"
cognit wrap -- pnpm test
cognit wrap -- ./scripts/smoke.sh
```

Captures tool calls, exit codes, stderr. Atomic write helper (`packages/wrap/src/atomic-write.ts`) so partial files are not picked up.

### 6.2 Claude Code hooks

In `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": "cognit observation add",
    "PreToolUse": "cognit hypothesis add"
  }
}
```

### 6.3 Worker inbox adapter (any AI tool)

Any worker can publish events by writing JSON files into `.cognit/inbox/`. The watcher (chokidar) validates schema, redacts secrets, appends to the store via the single boundary `appendEvent`.

**Atomic write protocol** (mandatory — partial writes are dropped):

```bash
cat > event.json.tmp <<'JSON'
{
  "schema_version": "1.2.0",
  "type": "hypothesis_ranked",
  "session_id": "01HXY...",
  "actor": { "type": "worker", "name": "ai-supervisor" },
  "source": { "tool": "ai-supervisor", "command": "tick-3" },
  "payload": {
    "hypothesis_id": "01HXY...",
    "score": 0.82,
    "reasoning": "Strongest reproducer; matches 3 supporting findings; recently verified.",
    "evaluator": "ai-supervisor",
    "override_rule_based": true,
    "context_event_ids": ["01HXY...", "01HXY..."]
  }
}
JSON
sync
mv event.json.tmp event.json
```

Unknown actors auto-register with the default trust score from `cognit.yaml`. Promote `ai-supervisor` to a known actor for a higher trust score.

### 6.4 `hypothesis_ranked` payload schema (v1.2.0)

```ts
{
  hypothesis_id: string,                   // required, non-empty
  score: number,                            // required, [0, 1]
  reasoning: string,                        // required, non-empty
  evaluator: "ai-supervisor",               // literal — only the supervisor emits these today
  override_rule_based: boolean,             // true = AI wins, false = fallback only
  context_event_ids?: string[],             // optional, prior events the AI saw
}
```

The reducer applies the AI score to the target hypothesis. `linked_hypothesis_id` is **not** used (that FK is reserved for verification events). The score is clamped defensively to `[0, 1]`; non-finite values fall back to the rule-based formula.

---

## 7. Core concepts in one screen

| Concept          | What it is                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Project**      | One per repo (one per `.cognit/`).                                                                                                                                                               |
| **Session**      | One investigation / engineering goal. Forkable from a previous session via `cognit session resume`.                                                                                              |
| **Actor**        | Source of an event: `human`, `worker` (Claude Code, Codex, OpenCode, Gemini CLI, `ai-supervisor`, …), or `system`. Each has a trust score.                                                       |
| **Observation**  | Raw fact — captured by `cognit wrap` or `cognit observation add`.                                                                                                                                |
| **Finding**      | Interpretation of one or more observations.                                                                                                                                                      |
| **Hypothesis**   | Testable claim. Lifecycle: `active → weakened \| rejected \| promoted`. Rejection carries a `reason_type`: `evidence \| superseded \| constraint`. Carries an optional `ai_rank_score` (v1.2.0). |
| **Theory**       | Group of related hypotheses. First-class — can be merged or archived.                                                                                                                            |
| **Experiment**   | A test. Always linked via a `tests` edge to the hypothesis it tests.                                                                                                                             |
| **Conclusion**   | Verified claim. Must be backed by at least one passed verification.                                                                                                                              |
| **Decision**     | Action commitment, `based_on` one or more conclusions.                                                                                                                                           |
| **Verification** | Reproducible run of a command (build, test, lint, typecheck, benchmark, custom). Lifecycle: `started → passed \| failed \| errored \| cancelled`.                                                |
| **Edge**         | Typed relationship (`tests`, `supports`, `contradicts`, `supersedes`, `caused`, `based_on`, `belongs_to`, `derived_from`, `references`).                                                         |
| **Artifact**     | Evidence file, addressed by sha256 (terminal logs, screenshots, diffs).                                                                                                                          |

The graph that matters:

```text
Decision ──based_on──▶ Conclusion ──verified_by──▶ Verification
   │
   └──caused──▶ Experiment ──tests──▶ Hypothesis ──ai_rank_score──▶ Ranker
                                              │
                            Experiment ──supports──▶ other Hypothesis
                            Experiment ──contradicts──▶ yet another
```

---

## 8. Resuming an investigation later

```bash
cognit session resume "Fix Next.js memory leak"
```

Forks a new session (default). Returns a context summary so the AI supervisor (or you) starts with the full picture — no chat scrollback required:

```text
Previous session found (01HXY...).

Goal:
Fix Next.js memory leak

Rejected hypotheses:
- Turbopack cache leak (reason: evidence)
- Production memory leak (reason: evidence)

Verified conclusions:
- Memory leak is in the HMR module graph, not Turbopack (verified by 01HXY...)

Accepted decisions:
- Disable HMR module caching in CI

Suggested next step:
Investigate module graph retention; strongest active hypothesis: "module listener leak"
```

Pass `--fork=false` to append to the same session. Pass `--id <ulid>` when multiple sessions match.

The **Suggested next step** line is the Gravity Engine v0.2 ranking with v1.2.0 AI-rank override. If the AI has scored the top hypothesis, that score wins; otherwise the 5-axis formula.

`cognit recovery search "<query>"` does a fuzzy search across goals, findings, hypotheses, decisions, and conclusions to find an old session you want to resume.

---

## 9. Inspecting from the terminal

```bash
# full session state (reducer output)
cognit session show <id-or-goal>

# live-tail the event stream
cognit events --session <id> --follow

# filter by type — useful for watching the supervisor
cognit events --type hypothesis_ranked --follow
cognit events --type verification_failed --follow

# recovery surface (top hypothesis + decisions + suggested next step)
cognit recovery <session-id>
cognit recovery search "memory leak"

# JSON envelope (scriptable)
cognit --json session list
cognit --json events --type hypothesis_ranked --limit 5 | jq '.data[0].payload'
```

`cognit --json <command>` wraps every command in a stable envelope `{ version: 1, kind, data }` parseable by `jq`.

---

## 10. Dashboard

```bash
cognit dashboard
```

Opens `http://localhost:6970` (default).

| Page                | Shows                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**        | Goal, confidence, progress, current strongest hypothesis, latest verification.                                                   |
| **Timeline**        | Event stream evolution. Filterable by type and actor.                                                                            |
| **Knowledge Graph** | All entities as nodes, all edge types as links. Toggle free / physics layout.                                                    |
| **Decision Graph**  | Decisions with `based_on` → conclusions and `caused` → experiments.                                                              |
| **Verification**    | All verifications with rerun history.                                                                                            |
| **Recovery Center** | Rejected hypotheses (with reason), verified conclusions, accepted decisions, suggested next steps.                               |
| **AI Reasoning**    | Live SSE feed of `hypothesis_ranked` events, AI rank history, decision log. Compare AI score vs rule-based score per hypothesis. |
| **Settings**        | Project config, redaction patterns, cleanup policy, storage usage, export/import.                                                |

If port `6970` is busy: `--port <n>`. The API server runs separately on `6971` (read-only Hono on loopback).

---

## 11. Secret redaction — defaults you can trust

Every event is scanned for secrets **at ingest**, before it touches the store. Built-in patterns:

- JWT
- `key=`, `api_key=`, `token=` inline values
- PEM private-key blocks
- `password=` fields

Add project-specific patterns in `cognit.yaml`:

```yaml
redaction:
  enabled: true
  patterns:
    - name: internal_bearer
      regex: "Bearer [A-Za-z0-9._-]{20,}"
      replacement: "Bearer [REDACTED]"
```

Test before saving:

```bash
cognit redaction test "Authorization: Bearer eyJhbGciOi...xyz"
```

> Redaction is at ingest, not retroactive. If a real secret lands in an old event, restore from an earlier `cognit export` and re-import.

---

## 12. Verifications — make claims prove themselves

A verification is a typed, reproducible run.

```bash
# start a verification
cognit verify --type benchmark --command "pnpm run bench:memory" \
  --tests "Module graph listener leak in HMR"

# explicit lifecycle control (for custom runners)
cognit verify start --type custom --command "./scripts/smoke.sh"
cognit verify pass --id <verification-id>
cognit verify fail --id <verification-id>

# rerun — previous run linked via parent_verification_id
cognit verify rerun --parent <verification-id> --command "..." --type test
```

| State       | Meaning                                     |
| ----------- | ------------------------------------------- |
| `started`   | Running.                                    |
| `passed`    | Exit code 0.                                |
| `failed`    | Exit code ≠ 0.                              |
| `errored`   | Could not even run (ENOENT, EACCES, EPERM). |
| `cancelled` | SIGINT / SIGTERM.                           |

`failed` and `errored` are different on purpose — distinguish "code under test broke" from "harness couldn't run". Output > 1 KB is captured as a sha256-keyed artifact under `.cognit/artifacts/`.

---

## 13. Constraints — automatic hypothesis pruning

```bash
cognit constraint add --json '{
  "condition": {
    "all": [
      { "event": "experiment_completed", "contradicts_includes": "$h.id" },
      { "entity": "hypothesis", "id": "$h.id", "state": "active" },
      { "entity": "hypothesis", "id": "$h.id", "confidence": { "lt": 0.3 } }
    ]
  },
  "actions": [
    {
      "type": "reject_hypothesis",
      "reason": "Contradicted by experiment and low confidence",
      "reason_type": "constraint"
    }
  ]
}'
```

Rules fire on `experiment_completed` and `verification_failed`. Available actions: `reject_hypothesis`, `weaken_hypothesis`, `promote_hypothesis`, `create_finding`. One contradicting experiment can prune a branch automatically.

---

## 14. Export, import, share

A session is a portable bundle.

```bash
cognit export --output investigation-2026-06-12.tar.gz --include-artifacts
cognit import --input investigation-2026-06-12.tar.gz --merge-strategy skip
```

Merge strategies:

| Strategy         | On collision                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `skip` (default) | Keep local, drop imported. Safe to re-run.                          |
| `overwrite`      | Replace local with imported.                                        |
| `fork`           | Rewrite every imported id and remap FK columns. Both sides survive. |

Bundle contents: `manifest.json`, `cognit.yaml`, `cognit.db`, optionally `artifacts/`.

---

## 15. Daily-driver CLI quick reference

```bash
# session lifecycle
cognit session create "goal" [--parent session-id]
cognit session list [--status active|paused|closed]
cognit session resume "goal-or-id" [--fork=true] [--id ulid]
cognit session pause
cognit session close
cognit session show <id-or-goal>
cognit recovery <session-id>
cognit recovery search "<query>"

# observations (raw input for the supervisor)
cognit observe "text" [--session <id>] [--confidence 0..1]
cognit observation add "text"

# AI supervisor
cognit agent run    [--session] [--provider mock|anthropic|openai|google|ollama]
                    [--model] [--once] [--max-ticks N] [--tick-interval-ms N]
cognit agent status [--session]
cognit agent stop   [--session]

# entity management (manual fallback / debug)
cognit finding "text" [--related <obs-id,obs-id>]
cognit hypothesis propose "title" [--text "body"]
cognit hypothesis weaken --id <h-id> --reason-type evidence|superseded|constraint
cognit hypothesis reject --id <h-id> --reason "..."
cognit hypothesis promote --id <h-id>
cognit theory add "text"
cognit theory merge --id <theory-id> --into <target-id>
cognit theory archive --id <theory-id>
cognit experiment add "text" --tests <h-id>
cognit experiment complete --id <exp-id> --result "text"
cognit decision propose "text" [--based-on <conclusion-id,id>]
cognit decision accept --id <d-id> --reason "..."
cognit decision reject --id <d-id> --reason "..."
cognit conclusion propose "text" [--based-on <h-id,id>]
cognit conclusion verify --id <c-id> --with <verification-id>

# verifications
cognit verify start --type build|test|lint|typecheck|benchmark|custom --command "cmd"
cognit verify pass --id <v-id>
cognit verify fail --id <v-id>
cognit verify error --id <v-id> --reason "..."
cognit verify cancel --id <v-id>
cognit verify rerun --parent <v-id> --command "cmd" --type <type>

# edges
cognit edge add --from <entity:id> --to <entity:id> \
  --kind supports|contradicts|tests|based_on|derived_from|references
cognit edge list [--session <id>] [--kind <kind>]

# constraints
cognit constraint add --json '{...}'
cognit constraint list
cognit constraint test --type <event-type> [--payload <json|file>]

# ops
cognit events [--session <id>] [--type <event-type>] [--limit <n>] [--follow]
cognit export --output <bundle.tar.gz> [--include-artifacts]
cognit import --input <bundle.tar.gz> [--merge-strategy skip|overwrite|fork]
cognit gc [--dry-run] [--force] [--max-age-days N]
cognit redaction test "<raw string>"
cognit snapshot
cognit inbox [--watch|--process]
cognit schema-dump
cognit server [--host <ip>] [--port <n>]
cognit dashboard [--port <n>]
cognit wrap -- <command> [args...]

# sticky session pointer — set automatically by `session create` / `resume`
# override per-command with --session <id>
```

---

## 16. Configuration (`cognit.yaml`)

```yaml
project:
  name: my-project # set automatically from directory name at init

redaction:
  enabled: true
  patterns:
    - name: internal_bearer
      regex: "Bearer [A-Za-z0-9._-]{20,}"
      replacement: "Bearer [REDACTED]"

cleanup:
  artifact_max_age_days: 30
  unreferenced_action: archive # archive | delete | keep
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
    - name: codex
      trust_score: 0.65
    - name: ai-supervisor
      trust_score: 0.75

inbox:
  watch: true
  debounce_ms: 200
  atomic_write_required: true

# gravity weights are configurable (sum must be 1.0 ± 0.001)
gravity:
  weights:
    evidence: 0.30
    reproducibility: 0.30
    confidence: 0.20
    trust: 0.10
    freshness: 0.10
  freshness_half_life_days: 14

# supervisor loop config (C2)
agent:
  provider: mock # mock | anthropic | openai | google | ollama
  model: mock-1
  max_actions_per_tick: 5 # 0 = rank-only ticks
  max_prompt_hypotheses: 50
```

Edit live:

```bash
cognit config --edit    # opens $EDITOR
cognit config --show    # prints effective config
```

---

## 17. Common recipes

### Drop the entire local store and re-init

```bash
rm -rf .cognit
cognit init
```

### Watch the supervisor's ranks in real time

```bash
cognit events --type hypothesis_ranked --follow
```

### Get the AI's current top hypothesis

```bash
cognit --json recovery <session-id> | jq '.data.suggested_next_steps[0]'
```

### Replay-debug an AI rank decision

```bash
cognit --json events --type hypothesis_ranked --limit 1 | \
  jq '.data[0].payload | {hypothesis_id, score, reasoning, context_event_ids}'
```

`context_event_ids` lists which prior events the AI saw when it decided. Use it to reconstruct the AI's view.

### Backup before risky experiments

```bash
cognit export --output backup-$(date +%F).tar.gz --include-artifacts
```

### Move a session to another machine

```bash
# on source
cognit export --output session.tar.gz --include-artifacts

# on target
cognit import --input session.tar.gz --merge-strategy fork
```

`fork` rewrites all imported ids so the session sits alongside local ones without colliding.

### Run the supervisor in CI / batch

```bash
cognit agent run --session <id> --once --max-ticks 1
```

### Docker quick start

```bash
docker compose up -d
open http://localhost:6970   # sign in with token "dev-token"
```

Wipe and re-seed:

```bash
docker compose down -v && docker compose up -d
```

---

## 18. Troubleshooting

| Symptom                                   | Cause                                                       | Fix                                                            |
| ----------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `command not found: cognit`               | `pnpm link` not run, or PATH missing global bin             | `pnpm link --global` and check `pnpm bin -g`                   |
| `no current session`                      | Sticky pointer unset                                        | `cognit session create "..."` or pass `--session <id>`         |
| Dashboard won't open                      | Port `6970` taken                                           | `cognit dashboard --port 7770`                                 |
| Worker events not picked up               | File written without atomic rename                          | Write `.tmp`, `fsync`, then `mv` to `.json`                    |
| `hypothesis_ranked` ignored               | Target hypothesis missing (orphan rank)                     | Check session state; ensure `hypothesis_created` precedes rank |
| AI score clamped or fallback used         | Out-of-range or non-finite `score`                          | Verify LLM output is finite number in `[0, 1]`                 |
| Supervisor errors on first tick           | Missing API key for chosen provider                         | Export the matching env var or use `--provider mock`           |
| Secret in old event                       | Redaction is ingest-only                                    | Restore from earlier `cognit export`, re-import                |
| `cognit recovery --session <id>` rejected | Subcommand takes positional `<session-id>`, not `--session` | `cognit recovery <session-id>`                                 |
| Migration error on start                  | Schema version drift                                        | Inspect `.cognit/cognit.db`; re-init if local-only             |

---

## 19. Architecture at a glance

| Package                | Role                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `@cognit/core`         | Domain types, Effect Schema, reducer, redaction, Effect services.                            |
| `@cognit/db`           | Drizzle ORM, `appendEvent` (single redaction boundary), inbox watcher.                       |
| `@cognit/gravity`      | Pure scoring fn + AI-rank override (v1.2.0).                                                 |
| `@cognit/agent`        | Effect supervisor loop, prompt builder, `AgentDecision` schema, apply step.                  |
| `@cognit/llm`          | Vercel AI SDK provider layer (Anthropic / OpenAI / Google / Ollama).                         |
| `@cognit/verification` | Subprocess engine: spawn, capture, 1 MB truncation, sha256 artifact, terminal-event mapping. |
| `@cognit/wrap`         | Producer of inbox envelopes for `cognit wrap -- <cmd>`.                                      |
| `@cognit/sdk`          | Programmatic API for workers.                                                                |
| `@cognit/recovery`     | v0.2 recovery envelope + fuzzy search.                                                       |
| `apps/cli`             | `cognit` binary — commander command tree, layer build.                                       |
| `apps/server`          | Hono read API on loopback `:6971`.                                                           |
| `apps/dashboard`       | Vite + React 19 SPA on `:6970`.                                                              |

---

## 20. Where to next

- `README.md` — full reference (architecture, schema, event types).
- `ARCHITECTURE.md` — system view, package map.
- `STACK.md` — Node 24, pnpm 9, Effect, Drizzle, Hono, Vite.
- `CONVENTIONS.md` — naming, layout, anti-patterns.
- `plan.xml` — data model and feature spec.
- Dashboard at `http://localhost:6970` after `cognit dashboard`.
- AI Reasoning tab — live `hypothesis_ranked` feed on the dashboard.
