# Cognit

> Remembers why your code looks like this.

**What did your AI actually think 3 months ago?**

Local-first reasoning memory for AI coding tools.

---

## Why not [Git | Jira | Claude Code | Cursor | chat logs]?

| Tool          | Tracks                | Captures at        | Searchable          | Survives          | Replaces           |
|---------------|-----------------------|--------------------|---------------------|-------------------|--------------------|
| Git           | what changed          | commit time        | by file/author      | forever           | never              |
| Jira          | what was planned      | ticket creation    | by status/assignee  | as long as Jira lives | never          |
| Claude Code   | the final chat        | chat end           | by session          | until the window closes | never       |
| Cursor        | the final chat        | chat end           | by session          | until the window closes | never       |
| Chat logs     | the conversation      | chat end           | by full text        | only if you saved them | never        |
| **Cognit**    | **why it changed**    | **every step**     | **by meaning**      | **forever, local**| **none of the above** |

Cognit does not replace any of those tools. It adds the layer none
of them have: the reasoning between observation and decision.

---

## What you get

- **Searchable.** Every observation, guess, and decision is
  indexed. Find the reasoning three months from now.
- **Resumable.** Pick up any investigation from the last
  conclusion. The next session starts where the last one stopped.
- **Switchable.** Change AI tools without losing context. Claude
  today, Codex tomorrow — the reasoning graph is the same.
- **Local-only.** A single SQLite file on your machine. No cloud,
  no account, no telemetry.

---

## Install

```bash
git clone https://github.com/phucle297/Cognit
cd Cognit
pnpm install
pnpm build
pnpm link --global

cd <your-project>
cognit init
```

`cognit init` detects which AI tools you have installed (Claude
Code, Codex, Gemini CLI, OpenCode) and wires Cognit hooks into each
one automatically. No manual `mkdir`, no `cp`, no JSON editing.

---

## Use your AI tool normally

```bash
claude
```

Hooks run on every tool call. Cognit preserves the investigation
in the background. The dashboard at `http://localhost:5173` shows
what your AI has been thinking.

```bash
cognit dashboard
```

---

## Find reasoning later

```bash
cognit recovery search "why did we drop the JWT refresh"
```

Returns the session, the chain of guesses and checks that led to
the decision, and a one-click way to resume that investigation.

---

## What Cognit is not

- Not an agent framework.
- Not a multi-agent platform.
- Not a workflow engine.
- Not a chat history database.
- Not a replacement for Git, Jira, or your AI tool.

Cognit is infrastructure for preserving engineering reasoning.

---

## How it works (one paragraph)

AI tools call hooks on every tool invocation. Each hook drops a
small JSON record into `.cognit/inbox/`. A background watcher
validates and persists each event into SQLite. The dashboard
folds the event log into a reasoning graph: observations,
hypotheses, decisions, conclusions. That graph is what makes the
next session, the next worker, or you-six-months-from-now pick up
where the last one left off.

---

## Documentation

- [docs/index.md](docs/index.md) — why Cognit exists, 90-second answer
- [docs/getting-started.md](docs/getting-started.md) — five-minute walkthrough
- [docs/why.md](docs/why.md) — "Why did AI make this change?"
- [docs/recover.md](docs/recover.md) — "How do I undo or revisit?"
- [docs/search.md](docs/search.md) — "How do I find past reasoning?"
- [docs/cli.md](docs/cli.md) — every command
- [docs/dashboard.md](docs/dashboard.md) — every tab

The README tells you what Cognit is. The docs tell you how.

---

## Uninstall

```bash
rm -rf .cognit
pnpm rm -g cognit
```

---

## License

MIT. See [LICENSE](LICENSE).