# Why Cognit exists

**What did your AI actually think 3 months ago?**

Cognit remembers the reasoning behind every change your AI tool makes.
Today. Three months from now. Forever. Locally, on your machine.

## What it is

A small background service that watches your AI tool as it works and
saves the *why* behind every step — what it observed, what it guessed,
what it decided, and whether that decision held up.

## Why you want it

- AI tools forget the moment chat ends. Cognit does not.
- The reasoning behind a change is rarely in the commit message.
- When something breaks later, you want to find the decision, not the
  diff.

## Install (60 seconds)

```bash
git clone https://github.com/phucle297/Cognit
cd Cognit
pnpm install
pnpm build
pnpm link --global

cd <your-project>
cognit init
```

`cognit init` detects Claude Code, Codex, Gemini CLI, and OpenCode
and wires everything up automatically.

## Use it

```bash
claude
```

Use your AI tool exactly as you do today. Cognit runs in the
background and remembers everything.

## Find reasoning later

```bash
cognit recovery search "why did we drop the JWT refresh"
```

Returns the session, the chain of guesses and checks that led to the
decision, and a one-click way to resume that investigation.

## Where to go next

- [getting-started.md](getting-started.md) — five-minute walkthrough
- [why.md](why.md) — "Why did AI make this change?"
- [recover.md](recover.md) — "How do I undo or revisit?"
- [search.md](search.md) — "How do I find past reasoning?"