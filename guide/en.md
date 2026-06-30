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

Requirements: **Node.js 22+** (Node 24 LTS fine), **pnpm 9**, **git**. Docker is optional — only needed if you want the bundled server in a container.

### 2.0 One-command bootstrap (recommended)

```bash
git clone <cognit-repo-url>
cd cognit
scripts/up.sh                # installs deps, builds, links `cognit` to PATH, starts Docker server
scripts/up.sh --no-docker    # same, but skip Docker (use `cognit server` on the host instead)
```

`scripts/up.sh` prints the absolute path to the linked `cognit` binary when it finishes. If `cognit` isn't on `PATH` afterwards, the script prints the exact `export PATH=…` line to add.

### 2.0.1 Manual bootstrap (step-by-step)

If you'd rather run each step yourself:

```bash
pnpm install                 # also runs `pnpm build` for each workspace via `prepare`
pnpm build                   # rebuild dist/ for @cognit/cli (tsup + copy-migrations)
cd apps/cli/ && pnpm link --global
```

> Why the link step? `apps/cli` is a tsup-bundled ESM binary. Linking it on the host (instead of running it inside Docker) gives `better-sqlite3` the glibc prebuild that matches your host libc — the Alpine-based Docker image would otherwise produce the musl prebuild, which won't load on glibc Linux or macOS.

Verify:

```bash
cognit --version             # 0.0.0 (or current)
cognit --help                # shows the public-tier command list
cognit doctor                # healthcheck — should print "All checks passed."
```

> Tip: workspace exec also works. From repo root: `pnpm exec cognit <subcommand>`. For a teardown that mirrors `up.sh`, see `scripts/down.sh --help`. The root `package.json` also exposes `pnpm setup` and `pnpm remove` as thin wrappers for those scripts.

### 2.1 LiteLLM proxy (for real LLM calls)

`cognit agent run` and `cognit ask` route real-LLM calls through a self-hosted **LiteLLM proxy** (OpenAI-compatible HTTP endpoint). Set it up once:

**Run the proxy** (pick one):

```bash
# pip / pypi
pip install 'litellm[proxy]'
litellm --config litellm.config.yaml

# or docker
docker run -p 4000:4000 \
  -v $(pwd)/litellm.config.yaml:/app/config.yaml \
  ghcr.io/berriai/litellm:main-stable --config /app/config.yaml
```

See <https://docs.litellm.ai/docs/proxy/configs> for the LiteLLM config schema. LiteLLM owns provider mapping — you only configure upstream providers in `litellm.config.yaml`.

**Set the master key**:

```bash
export LITELLM_MASTER_KEY=sk-...   # must match `general_settings.master_key` in your config
```

**Cognit config** (`cognit.yaml → llm`):

```yaml
llm:
  base_url: http://localhost:4000
  api_key_env: LITELLM_MASTER_KEY
  default_model: <your-default-model>
  model_aliases:
    quick: <fast-model>
    deep: <strong-model>
  commands:
    ask: { alias: quick }
    agent_run: { alias: deep }
```

> Note: `model_aliases` is free-form — you pick the names. `base_url`, `api_key_env`, `default_model`, and `commands` keys are reserved; everything else under `model_aliases` is yours to define. If you prefer explicit models per command, set `commands.<cmd>.model: <provider>/<id>` instead of using aliases.

Mock runs (`--model mock-1`) do **not** hit the proxy or read `LITELLM_MASTER_KEY`, so smoke tests stay green without a key.

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

# 2. create a session (sticky pointer is auto-set; you usually don't need $SID)
SID=$(cognit session create "Investigate the test flake" | awk '/^session:/{print $2}')
# or just copy the ULID printed after `session:`

# 3. feed it observations (raw facts)
cognit observe "test_foo fails ~1 in 5 runs on CI"
cognit observe "flaky test uses Date.now() in a retry loop"

# 4. run the supervisor (mock — no key required)
cognit agent run --session "$SID" --once --model mock-1
# emits hypothesis_ranked + applies the AI decision

# 5. see what the AI produced
cognit events --type hypothesis_ranked --session "$SID"
cognit recovery "$SID"
cognit continue "$SID"        # one-screen summary
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
cognit --json ask --prompt "explain <details>"
# → { version: 1, kind: "ask", data: { schema_version, model,
#      prompt_tokens, completion_tokens, text, attachments } }
# (--json is a GLOBAL flag, not on `cognit ask`)
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
# one-screen summary of the active session (default: last 24h)
cognit continue                       # alias: cog
cognit continue --all                 # bypass 24h filter

# full v0.2 recovery envelope for any session
cognit recovery <session-id>

# fuzzy search across sessions
cognit recovery search "memory leak"

# raw reducer output
cognit session show <id-or-goal>

# live-tail hypothesis ranks
cognit events --type hypothesis_ranked --follow
```

`cognit continue` output shape (text mode):

```text
Session:    <goal or "no goal">
Status:     active | paused | closed
Last work:  <iso timestamp>

Doing:      <latest observation, truncated>
Verified:   <conclusions with trust tag + reason bullets>
Decided:    <decisions with trust tag + reason bullets>
Open:       <hypotheses / verifications with reason bullets>
Next:       <top open hypothesis or accepted decision, else "(nothing open)">

Trust:  N verified · N accepted · N pending · N open · N rejected
```

Add `--json` for the envelope (`{ version: 1, kind: "continue", data: {...} }`).

### 4.8 Steer the loop

When the top hypothesis is wrong, or you want the AI to look elsewhere:

- **Send a new observation** that nudges the AI.
- **Reject the AI's choice** by emitting a `hypothesis_rejected` event yourself (manual CLI is a debug tool here, not the main path).

---

## 5. Manual CLI as fallback (debug only)

Direct CLI commands still exist. Use them to inspect, patch, or seed state — not as the primary flow.

```bash
# seed a theory / hypothesis manually for testing
cognit theory add "HMR resource retention" --text "root cause area for the Next.js memory leak"
cognit hypothesis propose "Turbopack cache is leaking memory" \
  --text "HMR resource retention is plausibly caused by Turbopack's on-disk cache." \
  --confidence 0.7

# run an experiment manually
cognit experiment add \
  --tests-hypothesis <h-id-from-propose> \
  --design "Disable Turbopack and measure memory growth"
cognit experiment complete --id <exp-id> \
  --result "Memory still increases after disabling Turbopack" \
  --contradicts <h-id-from-propose>

# reject a hypothesis with a typed reason
cognit hypothesis reject --id <h-id> \
  --reason-type evidence \
  --reason "Disabling Turbopack did not stop memory growth"
```

The `<h-id>` is the ULID printed by `cognit hypothesis propose`. Theory and experiment commands are soft-deprecated and emit a one-time warning; suppress with `COGNIT_QUIET_DEPRECATIONS=1`.

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
    "PreToolUse": "cognit decision propose"
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

# JSON envelope (scriptable). Note: --limit is not on `events`; pipe to jq or head
cognit --json session list
cognit --json events --type hypothesis_ranked | jq '.data[0].payload'
```

`cognit --json <command>` wraps every command in a stable envelope `{ version: 1, kind, data }` parseable by `jq`.

---

## 10. Dashboard

```bash
cognit dashboard
```

Opens `http://localhost:5173` (default — vite dev mode). Use `--docker` (or set `COGNIT_DOCKER=1`) to run the docker-compose stack on `http://localhost:6970`.

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

If the default port is taken: `--port <n>`. The read-only API server runs separately on `:6971` (Hono on loopback; `cognit server` to start). `cognit doctor` probes it.

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
# run a command (positional command, --type is required-ish for non-exec kinds)
cognit verify "pnpm test" --type test
cognit verify "/usr/bin/time -v pnpm run bench:memory" --type exec \
  --linked-hypothesis <hypothesis-id>

# explicit lifecycle control (for custom runners / external drivers)
cognit verify pass <verification-id>
cognit verify fail <verification-id>
cognit verify error <verification-id> --reason "could not run"

# cancel an in-flight verification
cognit verify cancel --id <verification-id> --reason "stopped manually"

# rerun chains to a previous run via parent_verification_id
cognit verify rerun <parent-verification-id>
```

Supported `--type` values: `test`, `lint`, `build`, `exec`, `typecheck`. `exec` is the catch-all for ad-hoc shell commands.

| State       | Meaning                                     |
| ----------- | ------------------------------------------- |
| `started`   | Running.                                    |
| `passed`    | Exit code 0.                                |
| `failed`    | Exit code ≠ 0.                              |
| `errored`   | Could not even run (ENOENT, EACCES, EPERM). |
| `cancelled` | SIGINT / SIGTERM.                           |

`failed` and `errored` are different on purpose — distinguish "code under test broke" from "harness couldn't run". Output > 1 KB is captured as a sha256-keyed artifact under `.cognit/artifacts/`.

Aliases for `verify`: `verification` (LLM-facing) and `check` (user-facing). Pick the one you remember; they all hit the same code path.

---

## 13. Constraints — automatic hypothesis pruning

Constraints (a.k.a. guardrails) are typed rules that fire on matching events and block downstream state from being accepted.

```bash
cognit constraint add --json '{
  "when":  { "event": "verification_failed", "verification_type": "test" },
  "then":  "block",
  "reason": "blocking merges on failing tests"
}'
```

Schema is `{ when: <event-predicate>, then: "block", reason: <text> }`. `when` accepts the same shape as `cognit constraint test --payload …` (event-name, entity predicates, comparison operators). `then` is currently a single literal: `"block"`. Rules fire on `verification_failed`, `experiment_completed`, and any other event matching the `when` clause. Dry-run a rule before saving:

```bash
cognit constraint test --type verification_failed \
  --payload '{"verification_id": "01HXY..."}'
```

List active rules:

```bash
cognit constraint list [--session <id>]
```

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
cognit init [options]                                   # bootstrap .cognit/, wire hooks, drop CLAUDE.md
cognit config [--edit] [--show]                         # opens $EDITOR or prints effective config
cognit env [key] [--shell]                              # print hook-relevant env vars for this project
cognit schema-dump                                      # v1 JSON envelope shape as TS
cognit doctor [--fix]                                   # healthcheck: tree, db, hooks, inbox, server
cognit reset [--yes] [--keep-config]                    # wipe .cognit/ (interactive confirm)
cognit update                                           # pnpm update -g cognit wrapper

# session lifecycle
cognit session create "goal" [--parent <session-id>] [--actor name:type]
cognit session list   [--status active|paused|closed]   # alias: ls
cognit session show   <id-or-goal>
cognit session resume <id-or-goal> [--fork true|false] [--search <query>]
cognit session pause  <id-or-goal> [--actor name:type]
cognit session close  <id-or-goal> [--actor name:type]
# sticky session pointer — set automatically by create / resume
# override any command with --session <id>

# ingest (raw input for the supervisor)
cognit observe "text" [--session <id>] [--confidence 0..1] [--actor name:type]
cognit finding "text" [--related <obs-id,obs-id>] [--confidence 0..1]
cognit append --type <event-type> [--payload <json|file>] [--session <id>]
cognit wrap -- <command> [args...]                       # capture stderr/exit → observations + verification

# snapshot
cognit snapshot [--session <id>]

# AI supervisor (§4.3)
cognit agent run    [--session <id>] [--model <provider/id>]
                    [--once] [--max-ticks N] [--tick-interval-ms N]
cognit agent status [--session <id>]
cognit agent stop   [--session <id>]                    # mock layer triggered by --model mock-1

# one-shot LLM query (§4.4)
cognit ask --prompt "..." [--model <id>] [--input <path|url|-|clipboard>]
          [--max-output-tokens N] [--temperature F]     # --json is a GLOBAL flag, not on ask

# entity lifecycle (manual fallback / debug) -- canonical verbs; aliases in parens
cognit hypothesis propose <title> --text <body> [--confidence 0..1]
cognit hypothesis weaken  --id <h-id> --reason <text>
cognit hypothesis reject  --id <h-id> --reason-type evidence|superseded|constraint [--superseded-by <h-id>]
cognit hypothesis promote --id <h-id> --to-theory <t-id>
cognit theory add     <title> --text <body>             # soft-deprecated; set COGNIT_QUIET_DEPRECATIONS=1
cognit theory update  --id <t-id> --text <body>
cognit theory merge   --id <src-id> --into <target-id>
cognit theory archive --id <t-id>
cognit experiment add      --tests-hypothesis <h-id> --design <text>   # soft-deprecated
cognit experiment complete --id <exp-id> --result <text> [--contradicts <h-id,id>]

# decision (alias: decide) and conclusion (alias: conclude) -- alias names are public tier
cognit decision propose   <text> [--based-on <conclusion-id,id>]
cognit decision accept    --id <d-id> [--based-on <conclusion-id,id>]
cognit decision reject    --id <d-id> --reason <text>
cognit decision supersede --id <d-id> --by <new-decision-id>

cognit conclusion propose <text> [--confidence 0..1]
cognit conclusion verify  --id <c-id> --verification <vid> --evidence <h-id,e-id>
cognit conclusion reject  --id <c-id> --reason <text>

# verifications (alias: check, verification)
cognit verify [--type test|lint|build|exec|typecheck]
              <cmd> [args...] [--linked-hypothesis <h-id>]   # default action: run
cognit verify cancel --id <v-id> --reason <text>
cognit verify pass   <v-id> [--exit-code N] [--duration-ms N] [--stdout-excerpt <text>]
cognit verify fail   <v-id> --stderr-excerpt <text> [--exit-code N]
cognit verify error  <v-id> --error <text> [--error-code <code>] [--duration-ms N]
cognit verify rerun  <parent-v-id>

# evidence
cognit artifact add --id <artifact-id> --role evidence|code|log|config [--session <id>]

# edges
cognit edge add  --from-type <t> --from-id <id> --to-type <t> --to-id <id> --kind <edge_type>
cognit edge list [--session <id>]

# constraints
cognit constraint add  --json '{"when":{...},"then":"block","reason":"..."}' [--session <id>]
cognit constraint list [--session <id>]
cognit constraint test --type <event-type> [--payload <json|file>]

# inspect
cognit events            [--session <id>] [--type <event-type>] [--follow]
cognit recovery <session-id>
cognit recovery search "<query>" [--status active|paused|closed]
cognit redaction test "<raw string>"
cognit continue [--all]   # summary of active session; --all bypasses 24h filter
cognit search  "<query>" [--limit N] [--status <s>]

# ops
cognit inbox    [--watch|--process]                # chokidar watcher
cognit export   --output <bundle.tar.gz> [--include-artifacts]
cognit import   --input <bundle.tar.gz> [--merge-strategy skip|overwrite|fork]
cognit gc       [--dry-run] [--force] [--max-age-days N]
cognit server   [--host <ip>] [--port <n>]         # Hono read API on :6971
cognit dashboard [--port <n>] [--docker] [--no-open]   # vite :5173 (default), docker :6970
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

# LiteLLM proxy routing for `cognit ask` + `cognit agent run` (spec §1)
llm:
  base_url: http://localhost:4000        # self-hosted LiteLLM proxy
  api_key_env: LITELLM_MASTER_KEY        # default; per-model override available
  default_model: <your-default-model>
  model_aliases:                         # free-form names you pick
    quick: <fast-model>
    deep: <strong-model>
  commands:
    ask: { alias: quick }                # used by `cognit ask`
    agent_run: { alias: deep }           # used by `cognit agent run`

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

> **Back-compat:** the legacy `agent.provider: mock` form is no longer accepted. The canned layer is reached via `model: "mock-1"` (or `--model mock-1` on the CLI). Real LLM calls always go through the LiteLLM proxy using either a `model_aliases` name or a full model id.

---

## 17. Common recipes

### Drop the entire local store and re-init

```bash
rm -rf .cognit
cognit init
```

…or use the wrapper that also tears down Docker and unlinks the global CLI:

```bash
scripts/down.sh --purge --yes   # wipe .cognit/, drop cognit-server + cognit-data volume
scripts/up.sh --no-docker       # rebuild + re-link CLI
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
cognit --json events --type hypothesis_ranked | jq '.data[0].payload |
  {hypothesis_id, score, reasoning, context_event_ids}'
```

`context_event_ids` lists which prior events the AI saw when it decided. Use it to reconstruct the AI's view. (Events has no `--limit`; pipe through `head`, `jq`, or `tail`.)

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
| `command not found: cognit`               | `pnpm link` not run, or PATH missing global bin             | `cd apps/cli && pnpm link --global && pnpm bin -g`            |
| Install script failed on better-sqlite3   | Wrong libc prebuild (musl vs glibc)                          | Re-run on the host: `scripts/up.sh --no-docker` (or run `pnpm rebuild better-sqlite3` in the workspace that pulled the wrong prebuild) |
| `no current session`                      | Sticky pointer unset                                        | `cognit session create "..."` or pass `--session <id>`         |
| Dashboard won't open on `:5173`            | Vite default port taken                                     | `cognit dashboard --port 5174`                                 |
| Dashboard silent / blank page             | You opened the docker URL (`:6970`) but ran local mode (`:5173`), or vice-versa | `cognit dashboard` for local; `cognit dashboard --docker` for nginx on `:6970` |
| Hooks not firing in Claude Code           | `cognit init` was never run, or `~/.claude/settings.json` was edited since | `cognit doctor --fix` (re-installs hooks + re-writes `cognit.yaml`) |
| Worker events not picked up               | File written without atomic rename                          | Write `.tmp`, `fsync`, then `mv` to `.json`                    |
| `hypothesis_ranked` ignored               | Target hypothesis missing (orphan rank)                     | Check session state; ensure `hypothesis_created` precedes rank |
| AI score clamped or fallback used         | Out-of-range or non-finite `score`                          | Verify LLM output is finite number in `[0, 1]`                 |
| `required env LITELLM_MASTER_KEY not set (model ..., source: ...)` | Proxy key missing for the resolved model | `export LITELLM_MASTER_KEY=...`, or set `api_key_env` / per-model override in `cognit.yaml → llm` (see §16) |
| `no model configured (set llm.default_model or pass --model)` | No flag, no `llm.default_model`, no `llm.commands.<cmd>.model` | Set `llm.default_model: anthropic/claude-sonnet-4-6` in `cognit.yaml`, or pass `--model <provider>/<id>` |
| `clipboard image read not supported on this platform` | `cognit ask --input clipboard` on plan9 / unsupported OS | Save the image to a file and use `--input <path>` instead |
| `cannot determine text vs binary (first bytes: ...)` | Stdin is not valid UTF-8 and not a known magic number | Use `--input <path>` to force the source, or pipe UTF-8 text |
| Supervisor errors on first tick           | Missing API key for chosen provider                         | `export LITELLM_MASTER_KEY=...` (LiteLLM proxy) or use `--model mock-1` for canned |
| Secret in old event                       | Redaction is ingest-only                                    | Restore from earlier `cognit export`, re-import                |
| `cognit recovery --session <id>` rejected | Subcommand takes positional `<session-id>`, not `--session` | `cognit recovery <session-id>`                                 |
| `verify --type benchmark …` rejected      | Benchmark is not a registered `--type`                      | Use `--type test\|lint\|build\|exec\|typecheck`                |
| Migration error on start                  | Schema version drift                                        | Inspect `.cognit/cognit.db`; re-init if local-only             |
| Need a health snapshot                    | Anything off after an upgrade                               | `cognit doctor` — prints PASS/FAIL per check + `--fix` for safe repairs |

---

## 19. Architecture at a glance

| Package                | Role                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `@cognit/core`         | Domain types, Effect Schema, reducer, redaction, Effect services.                            |
| `@cognit/db`           | Drizzle ORM, `appendEvent` (single redaction boundary), inbox watcher.                       |
| `@cognit/gravity`      | Pure scoring fn + AI-rank override (v1.2.0).                                                 |
| `@cognit/agent`        | Effect supervisor loop, prompt builder, `AgentDecision` schema, apply step.                  |
| `@cognit/llm`          | Direct HTTP client to an OpenAI-compatible endpoint (typically a self-hosted LiteLLM proxy). No external SDK middleman. The LlmProvider Tag in `@cognit/agent` defines the contract. |
| `@cognit/verification` | Subprocess engine: spawn, capture, 1 MB truncation, sha256 artifact, terminal-event mapping. |
| `@cognit/wrap`         | Producer of inbox envelopes for `cognit wrap -- <cmd>`.                                      |
| `@cognit/sdk`          | Programmatic API for workers.                                                                |
| `@cognit/recovery`     | v0.2 recovery envelope + fuzzy search.                                                       |
| `apps/cli`             | `cognit` binary — commander command tree, layer build.                                       |
| `apps/server`          | Hono read API on loopback `:6971` (`cognit server`).                                        |
| `apps/dashboard`       | Vite + React 19 SPA on `:5173` (local) / `:6970` (docker via `cognit dashboard --docker`).  |

---

## 20. Where to next

- `README.md` — full reference (architecture, schema, event types).
- `docs/architecture.md` — system view, package map.
- `docs/cli.md` — CLI reference (every flag).
- `docs/data-model.md` — event types, reducer shape.
- `docs/configuration.md` — `cognit.yaml` schema (full).
- `CONVENTIONS.md` — naming, layout, anti-patterns.
- `plans/plan.xml` — data model and feature spec.
- Dashboard at `http://localhost:5173` after `cognit dashboard` (local vite) — or `http://localhost:6970` with `cognit dashboard --docker`.
- `cognit doctor` — healthcheck + `--fix` for safe repairs.
- `scripts/up.sh` / `scripts/down.sh` — single-command install + teardown (also `--no-docker` / `--purge --clean --yes`).
- AI Reasoning tab — live `hypothesis_ranked` feed on the dashboard.

---

## 21. Development workflow (contributors)

If you're hacking on Cognit itself (not just running it), the root `package.json` exposes a small set of aggregate scripts. All of them delegate to the per-workspace scripts via Turbo.

```bash
pnpm install               # installs deps + runs `prepare` → build for each workspace
pnpm build                 # turbo run build — rebuilds dist/ for @cognit/cli + @cognit/server + @cognit/dashboard
pnpm setup                 # alias for `bash scripts/up.sh` (cold install + start)
pnpm remove                # alias for `bash scripts/down.sh --yes` (teardown)

# quality gate — runs everything in sequence; fail-fast
pnpm check                 # typecheck && lint && test

# individual gates
pnpm typecheck             # turbo run typecheck (tsgo --noEmit across workspaces)
pnpm lint                  # oxlint .
pnpm test                  # turbo run test (workspace tier scripts — unit + integration)
pnpm test:watch            # turbo watch — per-workspace vitest in watch mode

# formatter (oxfmt)
pnpm format                # write
pnpm format:check          # CI-friendly dry run

# dev mode — watches every workspace
pnpm dev                   # turbo watch dev (tsx for cli/server, vite for dashboard)

# full nuke
pnpm clean                 # turbo run clean && rm -rf node_modules .turbo
```

Per-workspace scripts (most useful when you're inside one package):

```bash
# apps/cli
pnpm --filter @cognit/cli test          # builds + runs unit + integration
pnpm --filter @cognit/cli test:unit     # no build, unit only
pnpm --filter @cognit/cli test:e2e      # builds + runs e2e (RUN_E2E=1 to actually execute)
pnpm --filter @cognit/cli dev           # tsx watch — no bundling, fastest iteration

# apps/server
pnpm --filter @cognit/server dev        # tsx watch on src/index.ts
pnpm --filter @cognit/server build      # tsup → dist/index.js (the Docker image target)

# apps/dashboard
pnpm --filter @cognit/dashboard dev     # vite dev on :5173
pnpm --filter @cognit/dashboard build   # vite build (production bundle)
```

The test tiers are wired in `apps/cli/vitest.config.ts`:

| Tier          | Path                                | Default? | Notes                                              |
| ------------- | ----------------------------------- | -------- | -------------------------------------------------- |
| `unit`        | `tests/unit/**/*.test.ts`           | yes      | pure modules, no child process                     |
| `integration` | `tests/integration/**/*.test.ts`    | yes      | spawns `node dist/index.js` against a tempdir     |
| `e2e`         | `tests/e2e/**/*.test.ts`            | no       | full server + watch + import/export; gated by `RUN_E2E=1` |

> **Heads up — `pnpm check` and the current typecheck.** Right now `pnpm typecheck` fails on a handful of `exactOptionalPropertyTypes` violations inside `apps/cli/src/commands/` (the strict mode flag in `tsconfig.base.json`). These are upstream source bugs, not package.json issues, and they don't block `pnpm install` → `pnpm build` → `cognit init`. The CLI bundles via tsup (esbuild), which doesn't run `tsc`. CI gates see them; users don't. Track fixes in `bd` once you start working through them.

Workspace conventions:

- All workspace packages (`@cognit/*`) ship TypeScript source directly — `main`/`types`/`exports` all point at `src/index.ts`. Only `apps/cli` and `apps/server` actually `tsup`-bundle.
- New dep → add to the right workspace's `package.json`. The pnpm workspace resolver hoists via the catalog-less default (`workspace:*` for internal).
- New public command → register in `apps/cli/src/index.ts` + add a file under `apps/cli/src/commands/`. Visibility (public vs `--internal`) is controlled by `apps/cli/src/visibility.ts`.
