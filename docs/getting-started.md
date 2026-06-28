# Getting started

## What is Cognit?

Cognit remembers the reasoning behind every change your AI tool
makes — what it observed, what it guessed, and what it decided.
That memory lives locally on your machine, so three months from now
you can ask "why does this file look like this?" and get the actual
answer from the AI itself, not a guess from your commit message.

## Why do I want it?

Git tracks what changed. Your AI tool tracks the chat. Cognit tracks
the *why* in between — the chain of guesses, checks, and decisions
that led to the change. When something breaks later, you want the
decision, not just the diff. See the comparison table at the top of
[README.md](../README.md) for the full picture.

## How do I install?

About 60 seconds, copy-paste:

```bash
git clone https://github.com/phucle297/Cognit
cd Cognit
pnpm install
pnpm build
pnpm link --global

cd <your-project>
cognit init
```

`cognit init` detects which AI tools you have installed — Claude
Code, Codex, Gemini CLI, or OpenCode — and wires Cognit into each
one automatically. No manual config, no JSON editing, no copying
files around. Re-running it on a project that is already initialised
is a no-op.

Prerequisites: Node 22 or newer, and pnpm 9.

## How do I use my AI tool normally?

Just use it the way you already do:

```bash
claude
# or codex, gemini, opencode
```

Cognit runs in the background and records every step of every
investigation as you go. Nothing to remember, nothing to invoke
manually. To see what your AI has been thinking, open the
dashboard:

```bash
cognit dashboard
```

The browser opens at `http://localhost:5173`. The Timeline view
shows each session as it unfolds.

## How do I find reasoning later?

When a file changes and you cannot remember why, search the way you
would ask a teammate:

```bash
cognit recovery search "why did we drop the JWT refresh"
```

Cognit returns matching sessions, the chain of guesses and checks
that led to the decision, and a one-click way to resume that
investigation from where it stopped. Search works on meaning, not
exact words, so describe the symptom if you do not remember the
decision: `cognit recovery search "login fails on mobile"`.

## How do I uninstall?

```bash
rm -rf .cognit
pnpm rm -g cognit
```

Cognit stores everything inside `.cognit/` inside your project, so
removing that folder wipes all local reasoning memory. Removing the
package from your global pnpm setup takes the CLI off your `PATH`.
Nothing lives outside those two places — no cloud account, no
remote server, nothing to clean up elsewhere.

## Next steps

- [index.md](index.md) — why Cognit exists, in 90 seconds
- [why.md](why.md) — "Why did AI make this change?"
- [recover.md](recover.md) — "How do I undo or revisit?"
- [search.md](search.md) — "How do I find past reasoning?"
- [dashboard.md](dashboard.md) — every tab in the dashboard
- [cli.md](cli.md) — every command
