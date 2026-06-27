# Cognit

> Git for AI cognition.

Code has Git.
Tasks have Jira.
AI has Cognit.

Cognit is a local-first cognition layer for AI-assisted software engineering.

It preserves the engineering reasoning created during development so it can be resumed, searched, verified, and reused after the original AI context is gone.

---

## Why Cognit?

AI coding tools are good at investigating problems.

They read files.
They inspect logs.
They form hypotheses.
They try approaches.
They reject wrong ideas.
They verify fixes.
They make decisions.

But when the task ends, most of that reasoning disappears.

Usually only these remain:

* code
* commits
* pull requests
* short summaries

The investigation itself is lost.

That means the next worker, the next session, or even the same developer six months later often has to rediscover the same context again.

Cognit exists to prevent that.

---

## The Idea

Git preserves code evolution.

Jira preserves task evolution.

Cognit preserves reasoning evolution.

It captures the engineering knowledge created while solving a task:

* what was observed
* what was inferred
* what was suspected
* what was tested
* what was rejected
* what was verified
* what was decided

Cognit is not a replacement for your AI coding tool.

It is the persistent layer behind it.

---

## What Cognit Stores

Cognit stores engineering cognition as structured knowledge.

A typical investigation looks like this:

```txt
Observation
  ↓
Finding
  ↓
Hypothesis
  ↓
Experiment
  ↓
Verification
  ↓
Conclusion
  ↓
Decision
```

Each step answers a different question.

| Concept      | Meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| Observation  | A raw fact seen in the project                                   |
| Finding      | An interpretation of one or more observations                    |
| Hypothesis   | A possible explanation that can be tested                        |
| Experiment   | A test designed to support or reject a hypothesis                |
| Verification | Evidence from a command, test, build, benchmark, or manual check |
| Conclusion   | A verified claim about the project                               |
| Decision     | An action chosen based on verified conclusions                   |

This makes the reasoning recoverable.

Not just the final answer.

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
├─ experiments
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

You should not need to manually write hypotheses, experiments, or conclusions while coding.

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

Typical views include:

* Overview
* Timeline
* Knowledge Graph
* Decision Graph
* Verifications
* Recovery

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

Then use your AI coding tool normally.

```bash
claude
```

Open the dashboard:

```bash
cognit dashboard
```

Default dashboard URL:

```txt
http://localhost:6970
```

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

cognit observation add "Next.js reaches 18GB during local development"

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

Detailed implementation docs live under `/docs`.

Recommended docs:

```txt
docs/architecture.md
docs/data-model.md
docs/events.md
docs/hooks.md
docs/cli.md
docs/dashboard.md
docs/configuration.md
docs/storage.md
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
