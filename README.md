# Cognit

> Remembers why your code looks like this.

```text
Git     remembers WHAT changed.
Jira    remembers WHAT was planned.
Cognit  remembers WHY the AI changed it.
```

Claude Code forgets the moment chat ends. Cognit makes the
reasoning behind every change searchable forever — locally, on your
machine, no cloud.

```text
claude / codex / gemini  ──►  Cognit  ──►  searchable reasoning
```

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

## What you get

- Every decision and why, searchable forever.
- Resume any investigation from the last conclusion.
- Switch AI tools without losing context.
- Local only. SQLite file. Nothing leaves your machine.

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
small JSON envelope into `.cognit/inbox/`. A background watcher
validates and persists each event into SQLite. The dashboard
folds the event log into a reasoning graph: observations,
hypotheses, decisions, conclusions. That graph is what makes the
next session, the next worker, or you-six-months-from-now pick up
where the last one left off.

---

## Documentation

- [`docs/cli.md`](docs/cli.md) — every command
- [`docs/dashboard.md`](docs/dashboard.md) — every tab
- [`docs/getting-started.md`](docs/getting-started.md) — walkthrough

The README explains what Cognit is. The docs explain how.

---

## Uninstall

```bash
rm -rf .cognit
pnpm rm -g cognit
```

---

## License

MIT. See [LICENSE](LICENSE).