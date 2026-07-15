# Cognit

> Remembers why your code looks like this.

**What did your AI actually think 3 months ago?**

Your AI writes code. Cognit remembers why — the observations,
decisions, and evidence behind every change — so the next session
tomorrow, next week, or on a different machine can pick up without
you re-explaining. Local-first. No server required. No cloud, no
account, no telemetry.

## Single-user, local-first

Cognit is built for **one developer on one machine**:

| You get | You do **not** get |
|---------|---------------------|
| Memory in `.cognit/` (SQLite) on disk | Team / multi-tenant sync |
| Optional loopback dashboard | Cloud account or SaaS |
| `export` / `import` tar to move projects | Live multi-machine replication |
| Hooks into your local AI CLIs | Shared org memory plane |

**Multi-machine** = export on A, copy the archive, import on B. There
is no background sync. Threat model and non-goals:
[docs/technical/scope.md](docs/technical/scope.md).

---

## Why not [Git | Jira | Claude Code | Cursor | chat logs]?

| Tool          | Tracks                | Captures at        | Searchable          | Survives          | Replaces           |
|---------------|-----------------------|--------------------|---------------------|-------------------|--------------------|
| Git           | what changed          | commit time        | by file/author      | forever           | never              |
| Jira          | what was planned      | ticket creation    | by status/assignee  | as long as Jira lives | never          |
| Claude Code   | the final chat        | chat end           | by session          | until the window closes | never       |
| Cursor        | the final chat        | chat end           | by session          | until the window closes | never       |
| Chat logs     | the conversation      | chat end           | by full text        | only if you saved them | never        |
| **Cognit**    | **why it changed**    | **every step**     | **by keyword**      | **forever, local**| **none of the above** |

Cognit does not replace any of those tools. It adds the layer none
of them have: the reasoning between observation and decision.

---

## What you get

- **Searchable.** Every observation, decision, and piece of evidence
  is recorded. Find the reasoning three months from now.
- **Resumable.** Pick up any investigation from the last conclusion.
  The next session starts where the last one stopped.
- **Switchable.** Change AI tools without losing context. Claude
  today, Codex tomorrow — the reasoning memory is the same.
- **Local-first.** All memory lives in a `.cognit/` directory in your
  project. No cloud, no account, no telemetry.

---

## Install

Requirements: **Node.js 22+**, **pnpm 9**, **git**. Docker is optional
(only if you want the containerized server).

### Recommended (from source)

```bash
git clone https://github.com/phucle297/Cognit
cd Cognit
pnpm run setup -- --no-docker   # or: ./scripts/up.sh --no-docker
```

`pnpm run setup` is an alias for `scripts/up.sh`. It runs
`pnpm install`, builds the CLI, and links `cognit` onto your global
pnpm bin. Pass flags after `--` (e.g. `-- --no-docker`).

| Goal | Command |
|------|---------|
| CLI only (no Docker) | `pnpm run setup -- --no-docker` |
| CLI + local server (Docker Compose) | `pnpm run setup` |
| Same via shell script | `./scripts/up.sh` / `./scripts/up.sh --no-docker` |

Useful `up.sh` / `setup` flags: `--no-docker`, `--build`,
`--force-recreate` (the latter two pass through to Docker Compose).

### Manual equivalent

```bash
pnpm install
pnpm --filter @cognit/cli build
cd apps/cli && pnpm link --global
```

### npm package (when published)

```bash
npm install -g @cognit/cli
# requires Node 22+; better-sqlite3 uses prebuilds (build tools only if prebuild missing)
```

### First project

```bash
cd <your-project>
cognit init
```

`cognit init` drops a `.cognit/` directory and a `CLAUDE.md` at your
project root. That `CLAUDE.md` is what teaches your AI tool when to
use Cognit — you don't need to read it. If you have Claude Code,
Codex, Gemini CLI, or OpenCode installed, `init` also wires capture
hooks into each one automatically.

You run `init` once per project. After that, you can forget Cognit
exists.

### Shell completion

```bash
cognit completion fish   # print script to stdout
cognit completion bash
cognit completion zsh
```

```fish
# fish
cognit completion fish > ~/.config/fish/completions/cognit.fish
```

```bash
# bash — eval once, or write into bash-completion dir
eval "$(cognit completion bash)"
```

### Teardown (dev / from source)

Mirror of setup — stops Docker, unlinks the global CLI, optionally
wipes local state:

```bash
pnpm run remove                 # or: ./scripts/down.sh
pnpm run remove -- --purge      # also delete this repo's .cognit/
pnpm run remove -- --clean      # also pnpm clean (node_modules + .turbo)
pnpm run remove -- --purge --clean --yes   # full nuke, no prompts
```

| Flag | Effect |
|------|--------|
| (none) | Docker down + remove global `cognit` link |
| `--purge` | Also `rm -rf .cognit/` in the Cognit repo |
| `--clean` | Also wipe workspace `node_modules` / `.turbo` |
| `--yes` / `-y` | Skip confirmation prompts |

Does **not** touch `.beads/` (separate issue tracker).

---

## How it works

Cognit's memory has five shapes — **observations, decisions,
verifications, conclusions**, read back with **continue / search**.

When your AI tool works in a project where Cognit is initialised, the
`CLAUDE.md` that `init` wrote tells it to call a few small commands as
it goes:

- noticed something worth remembering → `cognit observation "..."`
- about to make a non-trivial choice → `cognit decision propose "..."`
- ran a test / lint / build / typecheck → `cognit verification "..."`
- closing a decision with evidence → `cognit conclusion propose "..."`

Each command writes straight to a local SQLite database
(`.cognit/cognit.db`). Nothing leaves your machine. To pick up where a
session stopped, the AI (or you) runs:

```bash
cognit continue
```

That is the whole product. You don't type these commands — the AI
does, because the `CLAUDE.md` tells it to.

> **Hooks (optional).** `cognit init` also installs *passive* hooks
> that fire on every AI tool call and drop a JSON record into
> `.cognit/inbox/`. Those records are drained into the database
> automatically the next time you run any read command (`cognit
> continue`, `cognit search`, `cognit events`) — no background process
> required. `cognit inbox --watch` (real-time) and `cognit inbox
> --process` (one-shot flush) remain as advanced/optional knobs; the
> hook path itself is also optional — the command path above is what
> captures reasoning day to day.
>
> Orphan `.tmp` files left by a crashed atomic write are ignored by the
> watcher. Clean them with `cognit inbox --clean-tmp` (default: older
> than 30 days; config `cleanup.inbox_tmp_max_age_days`). AI-safe:
> `cognit --json inbox --clean-tmp`. See
> [docs/hooks/README.md](docs/hooks/README.md).

---

## The shape of a day with Cognit

**Morning.** Open Claude Code in your project. Start a task.

**During the day.** You work normally. Read files. Edit code. Run
tests. Claude proposes a fix, picks between two libraries, runs the
test suite, finds one failing. You don't run any Cognit commands —
Claude does. It records the reasoning as it goes: *I noticed X*,
*I decided Y*, *the test for Z passed*, *the conclusion is W*.

**End of day.** Close the laptop. Everything Claude recorded is saved
to `.cognit/` in your project. Nothing is lost.

**Tomorrow.** Open Claude Code again. Ask it to continue where it
stopped. Before it answers, it runs `cognit continue`, reads the
output — last observation, what was decided, what evidence exists,
what's still open — and picks up the thread without you saying a word.

### The five concepts (public verbs)

Everything you ever record is one of these. Full CLI reference:
[docs/cli.md](docs/cli.md). Power ontology and advanced lifecycle
commands live behind `cognit --internal`.

| Concept | Public command | Role |
|---------|----------------|------|
| Observation | `cognit observation "..."` | Fact noticed during work (one line) |
| Decision | `cognit decision propose "..."` | Non-trivial choice (propose → accept/reject/supersede) |
| Verification | `cognit verification "<cmd>" --type test\|lint\|build\|typecheck` | Evidence from a command run |
| Conclusion | `cognit conclusion propose "..."` | Claim backed by verifications |
| Continue / Search | `cognit continue` / `cognit search "..."` | Read memory back (session or topic) |

---

## Find reasoning later

Two weeks later, you remember you once picked between two libraries
for the auth layer, but not which one. Don't scroll chat history. Don't
grep through git log. Run:

```bash
cognit search "auth library"
```

You get a list of sessions that mentioned the topic, ranked by how
strongly each one matches, with a one-line reason per match, plus a
suggested next step:

```text
Continue with: 01HXXXX...
  cognit continue 01HXXXX...
```

Run that to reopen the session and read its full memory — the chain of
observations, decisions, and evidence that led to the choice. Search is
fuzzy keyword over the goals, observations, hypotheses, and decisions,
so use the words you would say to a teammate.

Want a visual view instead?

```bash
cognit dashboard
```

Opens a local dashboard at `http://localhost:5173` that folds the event
log into a reasoning graph — observations, hypotheses, decisions,
conclusions, and the evidence linking them.

---

## When something goes wrong

- **`cognit init` failed.** The error names the cause. Common fix:
  `rm -rf .cognit/cognit.db .cognit/cognit.db-* && cognit init`.
- **`cognit continue` shows "No memory yet."** The session has nothing
  recorded yet. Do some work, then re-run.
- **`cognit search "x"` returns nothing.** No past memory overlaps the
  query. The output suggests next steps.
- **Inbox full of `.tmp` files / hooks fail with EEXIST.** Crashed
  producers can leave orphan temps. Run
  `cognit inbox --clean-tmp` (or `--dry-run` first). Defaults to files
  older than 30 days; use `--max-age-days 0` to clear all orphans.
- **Want a full health report?** `cognit doctor`. Each FAIL line
  includes a one-line fix.

---

## Capture something yourself

Most of the time the AI drives. But sometimes you know something it
doesn't — a constraint from a meeting, a decision from last quarter.
Record it directly:

```bash
cognit observation "we sunset the v1 API on 2026-09-01; do not add new endpoints there"
```

One line. Tomorrow's session will see it.

## Move memory to another machine

```bash
cognit export --output project.tar.gz     # source machine
cognit import --input project.tar.gz      # destination
```

The bundle contains the project config, database, and (optionally) the
artifacts directory.

## Start clean

```bash
cognit reset --yes
cognit init
```

Keeps the project config, loses the recorded memories.

---

## What Cognit is not

- Not an agent framework.
- Not a multi-agent platform.
- Not a workflow engine.
- Not a chat history database.
- Not a replacement for Git, Jira, or your AI tool.

Cognit is infrastructure for preserving engineering reasoning.

---

## Documentation

The README is the user guide. Deeper references live under `docs/`:

- [docs/cli.md](docs/cli.md) — every command, flag, exit codes, completion
- [docs/technical/scope.md](docs/technical/scope.md) — product scope & threat model
- [docs/dashboard.md](docs/dashboard.md) — every dashboard route
- [docs/hooks/README.md](docs/hooks/README.md) — hook capture setup per AI tool
- [docs/technical/](docs/technical/) — architecture, data model, storage, config internals

---

## Uninstall

**From a source checkout** (preferred if you used `pnpm run setup`):

```bash
pnpm run remove -- --yes          # stop Docker + unlink global CLI
# optional: wipe this repo's .cognit/ and node_modules
pnpm run remove -- --purge --clean --yes
```

**Per-project memory** (any machine where you ran `cognit init`):

```bash
rm -rf .cognit                    # in that project root
```

**CLI only** (if you installed without the scripts):

```bash
pnpm rm -g @cognit/cli            # or: pnpm rm -g cognit
```

Cognit stores project memory inside `.cognit/` at each project root.
Removing that folder wipes local reasoning for that project. Teardown
via `pnpm run remove` / `scripts/down.sh` also drops the global CLI
link and optional Docker volumes. Nothing else is required for a
clean uninstall.

---

## License

MIT. See [LICENSE](LICENSE).
