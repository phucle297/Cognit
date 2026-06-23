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

Requirements: **Node.js 22+** (Node 24 LTS fine), **pnpm 9**, **git**.

```bash
pnpm install
pnpm build
cd apps/cli/ && pnpm link --global
```

Verify:

```bash
cognit --version
cognit agent --help    # confirms the supervisor subcommand is wired
cognit ask --help      # confirms the one-shot Gateway command is wired
```

> Tip: workspace exec also works. From repo root: `pnpm exec cognit <subcommand>`.

### 2.1 Gateway key (for real LLM calls)

`cognit agent run` and `cognit ask` route real-LLM calls through the **Vercel AI Gateway**. Set one env var:

```bash
export AI_GATEWAY_API_KEY=...    # required by Gateway for every provider
```

If you prefer a different env var name (e.g. to keep per-project keys separate), set `api_key_env` in `cognit.yaml → llm`. Per-model overrides also work — see §16.

Mock runs (`--model mock-1`) do **not** read `AI_GATEWAY_API_KEY`, so smoke tests stay green without a key.

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

## 3.5 Quickstart (5 minutes)

End-to-end first run. Uses the **mock provider** — no API key needed, decisions are canned but the wiring is real.

```bash
# 1. inside your repo
cd your-project
cognit init

# 2. create a session
SID=$(cognit session create "Investigate the test flake" | awk '/^Session:/{print $2}')
# or just copy the ULID printed to stdout

# 3. feed it observations (raw facts)
cognit observe "test_foo fails ~1 in 5 runs on CI"
cognit observe "flaky test uses Date.now() in a retry loop"

# 4. run the supervisor (mock — no key required)
cognit agent run --session "$SID" --once --model mock-1
# emits hypothesis_ranked + applies the AI decision

# 5. see what the AI produced
cognit events --type hypothesis_ranked --session "$SID"
cognit recovery "$SID"
```

If you don't pass `--model mock-1`, the supervisor reads `llm.default_model` from `cognit.yaml` and routes through the Gateway (§2.1). Mock runs skip the Gateway entirely — useful for smoke tests and CI.

For the longer supervisor loop (multiple ticks, AI-driven):

```bash
cognit agent run --session "$SID" --max-ticks 10 --tick-interval-ms 2000
# SIGINT = graceful stop between ticks
# second SIGINT = hard exit
```

Inspect from another terminal while it runs:

```bash
cognit agent status --session "$SID"
cognit events --type hypothesis_ranked --follow
```

---

## 4. The AI-supervisor flow (canonical)

The canonical loop is **observation in, AI reasoning out**. You capture observations, the supervisor reads state and emits typed events, Gravity ranks by AI judgement, you review.

### 4.1 Start a session

```bash
cognit session create "Fix Next.js memory leak"
```

Prints the session id (ULID). Use `--session <id>` later for precision.

### 4.2 Capture observations

`cognit observe "<text>"` is the **lowest-level ingest** command. It appends one `observation_recorded` event to the session store. Nothing more, nothing less — no interpretation, no ranking, no LLM call.

**Internal flow:**

```text
cognit observe "<text>" --session <id>
        │
        ▼
 CognitionService.recordObservation({ text, actor, confidence? })
        │
        ▼
 SessionService.appendEvent          ← single chokepoint (constraint engine hook lives here)
        │
        ▼ redact secrets (§11)
        │
        ▼ reducer
 state.observations = [...state.observations, { id, text, created_at }]
```

After that, the next supervisor tick reads `state.observations`, builds the prompt, and reasons over them. Observations are the only input the human provides — every other event (`hypothesis_ranked`, `experiment_completed`, …) is emitted by the supervisor or manual debug commands.

**Flags:**

- `<text>` — required, positional. The observation.
- `--session <id>` — session ULID. Defaults to the sticky pointer set by `session create` / `resume`.
- `--actor name:type` — who observed. Default `cognit-cli:system` (trust 1.0). Use `human:you` to attribute to a person, `worker:claude-code` for an AI tool.
- `--confidence <0..1>` — optional. Weights Gravity scoring for downstream hypotheses.
- `--root <path>` — project root. Defaults to nearest `.cognit/cognit.yaml`.

**Two ways to capture:**

```bash
# (a) direct — you type the observation
cognit observe "Next.js reaches 18GB VmPeak during local dev"
cognit observe "Memory growth starts after HMR updates"

# (b) wrap — shell command's stderr/exit becomes observations + a verification event
cognit wrap -- pnpm run bench:memory
# stderr lines → observation_recorded (one per line)
# exit code 0 → verification_passed
# exit code ≠ 0 → verification_failed
# could not run (ENOENT) → verification_errored
```

**How `observe` differs from the other ingest commands:**

| Command | Level | Emits | Use when |
| --- | --- | --- | --- |
| `cognit observe "<text>"` | raw fact | `observation_recorded` | you saw something worth recording |
| `cognit finding "<text>" --related <obs-id,obs-id>` | interpretation | `finding_created` | you're claiming what one or more observations mean |
| `cognit append` | raw event (any type) | whatever you put in the payload | generic escape hatch / custom integrations |
| `cognit wrap -- <cmd>` | auto | `observation_recorded` (per stderr line) + terminal `verification_*` | running a build/test/lint; capture is automatic |

The observations land in the event store. They are the raw facts the supervisor reasons over.

### 4.3 Run the supervisor

The supervisor is **config-driven**. Set your default model once in `cognit.yaml → llm.default_model`, then run with no flags:

```bash
# mock LLM (no API keys, deterministic canned decisions)
cognit agent run --session <id> --model mock-1

# Gateway route — model resolved from llm.default_model in cognit.yaml
cognit agent run --session <id>

# Override the config from the CLI
cognit agent run --session <id> --model anthropic/claude-sonnet-4-6
cognit agent run --session <id> --model openai/gpt-4o
cognit agent run --session <id> --model google/gemini-2.5-pro
cognit agent run --session <id> --model ollama/llama3.1

# one-shot: one tick then exit
cognit agent run --session <id> --once

# bounded run
cognit agent run --session <id> --max-ticks 5 --tick-interval-ms 2000
```

Model resolution order (spec §2):

1. `--model <id>` flag
2. `llm.commands.agent_run.model` in `cognit.yaml`
3. `llm.default_model` in `cognit.yaml`
4. Error: `no model configured (set llm.default_model or pass --model)`

Each tick:

1. Tail events since the cursor.
2. Replay state via the reducer.
3. Build a prompt (capped at 50 hypotheses by default).
4. Call the LLM via Gateway, parse the JSON into an `AgentDecision` schema.
5. Apply the decision (up to 5 actions per tick by default).
6. Emit `hypothesis_ranked` events that the Gravity Engine consumes.

SIGINT flips a flag the loop checks between ticks; a second SIGINT hard-exits.

### 4.4 One-shot ask with multimodal

For a single prompt (no supervisor loop), use `cognit ask`. It routes through the same Gateway but skips the reducer / apply steps:

```bash
# Plain text — model from config or --model flag
cognit ask --prompt "explain the difference between <details> and <summary> in HTML"

# Override the model
cognit ask --model anthropic/claude-sonnet-4-6 --prompt "explain <details>"

# Cap output tokens + set sampling temperature
cognit ask --prompt "summarise" --max-output-tokens 256 --temperature 0.2

# Stable JSON envelope for downstream tooling
cognit ask --json --prompt "explain <details>"
# → { version: 1, kind: "ask", data: { schema_version, model,
#      prompt_tokens, completion_tokens, text, attachments } }
```

**Multimodal input** — attach a local image, a URL, a file, or a clipboard snapshot:

```bash
# Local image as an image attachment (magic-number sniff detects PNG/JPEG/etc.)
cognit ask --prompt "what's in this diagram?" --input ./diagram.png

# URL — fetched and attached
cognit ask --prompt "describe" --input https://example.com/photo.jpg

# Local text file — content folded into the prompt (text/* MIME)
cognit ask --prompt "summarise" --input ./notes.md

# Stdin via pipe — text or binary
cat diagram.png | cognit ask --prompt "what does this show?"
echo "explain this error: ENOSPC" | cognit ask

# Clipboard image — reads the OS clipboard snapshot
cognit ask --prompt "what's on my clipboard?" --input clipboard
```

Input resolution order (spec §3):

1. `--input <source>` (path / URL / `-` for stdin / `clipboard`)
2. Piped stdin (text folded into prompt, binary attached)
3. TTY + clipboard has image → clipboard image
4. Text-only prompt (no multimodal)

Exit codes (spec §3):

- `0` success
- `1` network / HTTP error from the Gateway
- `2` missing model / missing env / file not found / unknown MIME / clipboard unsupported / stdin ambiguous / `--prompt` required
- `3` model not in the Gateway catalog
- `130` SIGINT

### 4.5 Supervise from another terminal

```bash
cognit agent status --session <id>   # running, tick count, last tick id
cognit agent stop   --session <id>   # idempotent
```

### 4.6 Gravity ranks by AI scores

When the supervisor emits `hypothesis_ranked`, the **Gravity Engine** (v1.2.0) reads the AI score and uses it as the authoritative rank. The 5-axis rule-based score (evidence + reproducibility + confidence + actor trust + freshness decay) becomes the **fallback** for hypotheses the AI has not yet scored.

Each `RankedHypothesis` carries a `source: "ai" | "rule"` so you can tell which path produced the score.

### 4.7 Inspect the recovery surface

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

### 4.8 Steer the loop

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
    "PostToolUse": "cognit observe",
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
| **Observation**  | Raw fact — captured by `cognit wrap` or `cognit observe`.                                                                                                                                       |
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

Every command below matches `cognit <subcommand> --help` output exactly.

```bash
# project
cognit init [options]
cognit config [--edit] [--show]                # opens $EDITOR or prints effective config
cognit schema-dump                            # v1 JSON envelope shape as TS

# session lifecycle
cognit session create "goal" [--parent <session-id>]
cognit session list   [--status active|paused|closed]
cognit session show   <id-or-goal>
cognit session resume "goal-or-id" [--fork=true|false] [--id <ulid>]
cognit session pause
cognit session close
# sticky session pointer — set automatically by create / resume
# override any command with --session <id>

# ingest (raw input for the supervisor)
cognit observe "text" [--session <id>] [--confidence 0..1] [--actor name:type]
cognit finding "text" [--related <obs-id,obs-id>]
cognit append [options]                        # generic raw-event append
cognit wrap -- <command> [args...]              # capture stderr/exit → observations + verification

# snapshot
cognit snapshot [options]

# AI supervisor (§4.3)
cognit agent run    [--session <id>] [--model <provider/id>]
                    [--once] [--max-ticks N] [--tick-interval-ms N]
cognit agent status [--session <id>]
cognit agent stop   [--session <id>]  # mock layer triggered by --model mock-1

# one-shot LLM query (§4.4)
cognit ask --prompt "..." [--model <id>] [--input <path|url|-|clipboard>]
          [--max-output-tokens N] [--temperature F]

# entity lifecycle (manual fallback / debug)
cognit hypothesis propose "title" [--text "body"] [--confidence 0..1]
cognit hypothesis weaken  --id <h-id> --reason-type evidence|superseded|constraint
cognit hypothesis reject  --id <h-id> --reason "..."
cognit hypothesis promote --id <h-id>
cognit theory add     "title" [--text "body"]
cognit theory update  --id <t-id> [--title ...] [--text ...]
cognit theory merge   --id <src-id> --into <target-id>
cognit theory archive --id <t-id>
cognit experiment add      "text" --tests <h-id[,h-id]>
cognit experiment complete --id <exp-id> --result "text" [--contradicts <h-id>]
cognit decision propose   "text" [--based-on <conclusion-id[,id]>]
cognit decision accept    --id <d-id> --reason "..."
cognit decision reject    --id <d-id> --reason "..."
cognit decision supersede --id <d-id> --with "new text" [--based-on ...]
cognit conclusion propose "text" [--based-on <h-id[,id]>]
cognit conclusion verify  --id <c-id> --with <verification-id>
cognit conclusion reject  --id <c-id> --reason "..."

# verifications
cognit verify [--type build|test|lint|typecheck|benchmark|custom]
              --command "cmd" [--tests <h-id>] [--timeout-ms N]   # default action: run
cognit verify cancel --id <v-id>
cognit verify pass   <verification-id>    # inject verification_passed
cognit verify fail   <verification-id>    # inject verification_failed
cognit verify error  <verification-id> --reason "..."
cognit verify rerun  --parent <v-id> --command "cmd" [--type ...]

# evidence
cognit artifact add <path> [--session <id>] [--kind <k>] [--label "..."]

# edges
cognit edge add  --from <entity:id> --to <entity:id> \
                 --kind supports|contradicts|tests|based_on|derived_from|references|caused
cognit edge list [--session <id>] [--kind <kind>]

# constraints
cognit constraint add  --json '{...}' [--session <id>]
cognit constraint list [--session <id>]
cognit constraint test --type <event-type> [--payload <json|file>]

# inspect
cognit events            [--session <id>] [--type <event-type>] [--limit <n>] [--follow]
cognit recovery <session-id>
cognit recovery search "<query>"
cognit redaction test "<raw string>"

# ops
cognit inbox    [--watch|--process]                # chokidar watcher
cognit export   --output <bundle.tar.gz> [--include-artifacts]
cognit import   --input <bundle.tar.gz> [--merge-strategy skip|overwrite|fork]
cognit gc       [--dry-run] [--force] [--max-age-days N]
cognit server   [--host <ip>] [--port <n>]         # Hono read API on :6971
cognit dashboard [--port <n>]                       # Vite SPA on :6970
```

Global flags (apply to every command):

```bash
--json          # emit stable envelope { version, kind, data }
--root <path>   # project root (default $COGNIT_ROOT or cwd)
-V, --version
-h, --help
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

# Gateway routing for `cognit ask` + `cognit agent run` (spec §1)
llm:
  api_key_env: AI_GATEWAY_API_KEY  # default; per-model override available
  default_model: anthropic/claude-sonnet-4-6
  models:
    openai/gpt-4o:
      api_key_env: OPENAI_API_KEY   # this model uses a direct key
  commands:
    ask:
      model: anthropic/claude-sonnet-4-6  # used by `cognit ask`
    agent_run:                            # used by `cognit agent run`
      model: openai/gpt-4o

# supervisor loop config (C2) — applied AFTER the Gateway layer is built.
agent:
  max_actions_per_tick: 5 # 0 = rank-only ticks
  max_prompt_hypotheses: 50
```

Edit live:

```bash
cognit config --edit    # opens $EDITOR
cognit config --show    # prints effective config
```

> **Back-compat:** the legacy `agent.provider: mock` form is no longer accepted. The canned layer is reached via `model: "mock-1"` (or `--model mock-1` on the CLI). Real LLM calls always go through the Vercel AI Gateway using the full model id format.

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
| `required env AI_GATEWAY_API_KEY not set (model ..., source: ...)` | Gateway key missing for the resolved model | `export AI_GATEWAY_API_KEY=...`, or set `api_key_env` / per-model override in `cognit.yaml → llm` (see §16) |
| `no model configured (set llm.default_model or pass --model)` | No flag, no `llm.default_model`, no `llm.commands.<cmd>.model` | Set `llm.default_model: anthropic/claude-sonnet-4-6` in `cognit.yaml`, or pass `--model <provider>/<id>` |
| `clipboard image read not supported on this platform` | `cognit ask --input clipboard` on plan9 / unsupported OS | Save the image to a file and use `--input <path>` instead |
| `cannot determine text vs binary (first bytes: ...)` | Stdin is not valid UTF-8 and not a known magic number | Use `--input <path>` to force the source, or pipe UTF-8 text |
| Supervisor errors on first tick           | Missing API key for chosen provider                         | `export AI_GATEWAY_API_KEY=...` (Gateway) or use `--model mock-1` for canned |
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
