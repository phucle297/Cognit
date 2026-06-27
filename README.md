# Cognit

> Git for AI cognition.

```txt
Claude Code     ─┐
Codex CLI       ─┤
Gemini CLI      ─┼──►   Cognit   ──►   reasoning graph
OpenCode        ─┤      (local)        (sessions, events,
custom scripts  ─┘                      hypotheses, decisions)
```

Cognit is a local-first reasoning layer for AI-assisted engineering.
It preserves the engineering knowledge produced during an
investigation — observations, hypotheses, experiments, decisions —
so the next worker, the next session, or the same developer six
months later does not have to rediscover the same context.

It is not an agent framework, a workflow engine, or a chat-history
database. It is the persistent layer behind whatever AI tool you
already use.

---

## Without Cognit vs With Cognit

```txt
Without Cognit                   With Cognit
─────────────────────            ─────────────────────
Claude                           Claude
  ↓                                ↓
context lost                   Cognit
  ↓                                ↓
start over                     Codex  (or Gemini, OpenCode, …)
                                 ↓
                               continue
```

| Without Cognit                              | With Cognit                                       |
|---------------------------------------------|---------------------------------------------------|
| AI forgets when the chat ends               | Every observation preserved                       |
| Next session restarts from zero             | Resume any investigation from the last decision   |
| Decisions disappear with the chat           | Decisions stay searchable forever                 |
| Switching AI tools loses context            | Switch AI tools without losing context            |
| Six-month-old investigation is gone         | Six-month-old investigation is one search away   |

---

## Why install today

Most teams lose engineering reasoning every day. They just do not
notice until they have to redo it.

Cognit fixes that with one `cognit init` and your existing AI
workflow. No new agent framework to learn. No new UI. The hooks
capture what your tool already does.

---

## What Cognit Stores

Cognit stores engineering cognition as structured knowledge.

The canonical flow:

```txt
Observation
  ↓
Finding
  ↓
Hypothesis
  ↓
Verification
  ↓
Conclusion
  ↓
Decision
```

| Concept      | Meaning                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| Observation  | A raw fact seen in the project                                                           |
| Finding      | An interpretation of one or more observations                                            |
| Hypothesis   | A possible explanation that can be tested                                                |
| Verification | Evidence from a command, test, build, benchmark, or manual check                         |
| Conclusion   | A verified claim about the project                                                       |
| Decision     | An action chosen based on verified conclusions                                           |
| Artifact     | Attached evidence — code, log, config, or any external file referenced by the reasoning |
| Edge         | A link between entities — supports, contradicts, supersedes, or otherwise relates them   |
| Session      | A unit of investigation; lifecycle is `active` / `paused` / `closed`                     |

Two more concepts exist for multi-step reasoning flows that need
explicit evidence collection (`Experiment`) or higher-level model
assembly (`Theory`). Most investigations use the canonical flow
above; `Theory` and `Experiment` are documented in
[`docs/cli.md`](docs/cli.md) under "Advanced lifecycle commands".

This makes the reasoning recoverable.

Not just the final answer.

---

## Storage

Cognit stores an append-only reasoning graph in a local SQLite file
inside the project (`.cognit/cognit.db`).

Two layers:

- **Reasoning model** — sessions, events, hypotheses, findings,
  conclusions, decisions, artifacts, edges.
- **Infrastructure** — actors, projects, constraint rules, version
  ledger, inbox sidecar.

Schema, migrations, and the exact table list live in
[`docs/storage.md`](docs/storage.md) and
[`docs/data-model.md`](docs/data-model.md).

---

## Session First

Most AI workflows are worker-first.

```txt
AI worker
├─ memory
├─ context
└─ task
```

When the worker stops, the context is usually gone.

Cognit is session-first.

```txt
Session
├─ observations
├─ findings
├─ hypotheses
├─ verifications
├─ conclusions
└─ decisions
```

Workers are temporary.

The session is permanent.

A session can be continued by:

* Claude Code
* Codex
* Gemini CLI
* OpenCode
* custom scripts
* humans

The worker can change.

The investigation does not reset.

---

## Zero Workflow

Cognit is designed to fit into your existing AI workflow.

You should not need to manually write hypotheses, experiments, or
conclusions while coding.

The intended flow is simple:

```bash
git clone <repo>
cd <repo>

docker compose up -d

cognit init
```

Then open your AI coding tool and work normally.

For example:

```bash
claude
```

or:

```bash
codex
```

Cognit runs behind the workflow.

It captures useful engineering knowledge through hooks, command wrappers, and adapters.

The goal is not to make developers operate a new system.

The goal is to make AI-assisted work persistent by default.

---

## Resume Without Chat Context

The most important feature of Cognit is recovery.

Imagine this task:

```txt
Fix Next.js local memory growth
```

During the investigation, several ideas are tried.

```txt
Rejected:
- Turbopack cache leak
- Production-only memory leak

Verified:
- Memory growth happens after repeated HMR updates
- Disabling Turbopack does not stop the issue

Decided:
- Stop investigating Turbopack
- Focus on HMR module graph retention
```

Six months later, you can resume the task without loading the old chat.

Cognit can show:

```txt
Goal:
Fix Next.js local memory growth

Rejected approaches:
- Turbopack cache leak
- Production-only memory leak

Verified conclusions:
- The leak is related to HMR state retention
- Turbopack is not the root cause

Accepted decisions:
- Do not disable Turbopack as the primary fix

Suggested next step:
Investigate module graph listener retention
```

This is the core value.

The AI context can disappear.

The engineering cognition remains.

---

## Dashboard

Cognit includes a local dashboard for inspecting active and past investigations.

The dashboard helps answer questions like:

```txt
What is the current strongest hypothesis?

Why was this approach rejected?

What evidence supports this decision?

What has already been verified?

Where should the next worker continue?
```

The dashboard covers four high-level surfaces:

* **Overview** — current state of the project.
* **Timeline** — chronological event stream.
* **Knowledge Graph** — entities and how they relate.
* **Recovery** — "why was this approach rejected?" with full audit.

Routes, lazy loading, and Docker publishing rules live in
[`docs/dashboard.md`](docs/dashboard.md).

The dashboard is for visibility.

Your normal coding workflow stays in your editor and AI tool.

---

## How It Fits Together

At a high level:

```txt
AI coding tool
     ↓
hooks / wrappers / adapters
     ↓
Cognit session
     ↓
local store
     ↓
dashboard / recovery
```

Cognit does not need to own the AI worker.

It only needs to preserve the useful engineering state produced by the worker.

---

## Installation

Start the local stack:

```bash
docker compose up -d
```

Initialize Cognit inside a project:

```bash
cognit init
```

`cognit init` creates the project inbox (`.cognit/inbox/`) and writes
the hooks config template — see [`docs/cli.md`](docs/cli.md).

Then use your AI coding tool normally.

```bash
claude
```

Open the dashboard:

```bash
cognit dashboard
```

Default dashboard URLs (see [`docs/dashboard.md`](docs/dashboard.md)
for the full rule):

| Profile               | URL                          |
|-----------------------|------------------------------|
| Local dev             | `http://localhost:5173`      |
| Docker publish        | `http://localhost:6970`      |

---

## What Cognit Is Not

Cognit is not an agent framework.

Cognit is not a multi-agent platform.

Cognit is not a workflow engine.

Cognit is not a chat history database.

Cognit is not a replacement for Git, Jira, Claude Code, Codex, or Gemini CLI.

Cognit is infrastructure for preserving engineering cognition.

---

## Advanced Usage

Cognit also supports lower-level commands for debugging, scripting, and custom integrations.

Examples include:

```bash
cognit session create "Fix memory leak"

cognit observe "Next.js reaches 18GB during local development"

cognit verify --type test --command "pnpm test"

cognit recovery search "memory leak"
```

These commands are useful for automation and development.

They are not the primary user workflow.

The primary workflow is:

```txt
Initialize Cognit once.

Use your AI coding tool normally.

Let Cognit preserve the investigation.
```

---

## Documentation

Detailed implementation docs live under [`docs/`](docs/), ordered
by learning path:

```txt
docs/getting-started.md     first cognit init + first hook
docs/cli.md                 command reference
docs/hooks.md               how external CLIs publish to Cognit
docs/hooks/README.md        common behavior + atomic-write protocol
docs/architecture.md        repo layout, data flow, subsystems
docs/storage.md             SQLite file + .cognit/ directory
docs/data-model.md          tables, events, reducer
docs/dashboard.md           dashboard routes + URLs
docs/configuration.md       cognit.yaml schema
docs/events.md              envelope shape + migration runner
```

The README explains what Cognit is and why it exists.

The docs explain how Cognit works.

---

## Philosophy

Workers are temporary.

Knowledge is permanent.

Git preserves code evolution.

Cognit preserves reasoning evolution.

AI reasoning should not disappear when the context window ends.
