# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

> **Architecture in one line:** Issues live in a local Dolt database
> (`.beads/dolt/`); cross-machine sync uses `bd dolt push/pull` (a
> git-compatible protocol), stored under `refs/dolt/data` on your git
> remote — separate from `refs/heads/*` where your code lives.
> `.beads/issues.jsonl` is a passive export, not the wire protocol.
>
> See [SYNC_CONCEPTS.md](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md)
> for the one-screen overview and anti-patterns (don't treat JSONL as the
> source of truth; don't `bd import` during normal operation; don't
> reach for third-party Dolt hosting before trying the default).

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See <https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md> for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git commit` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Commit** - This is MANDATORY:

   ```bash
   git pull --rebase
   git commit
   git status  # MUST show "up to date with origin"
   ```

5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git commit` succeeds
- NEVER stop before committing - that leaves work stranded locally
- NEVER push if branch is develop/dev/master/main/pre-prod/qa/test/staging

## Quality Gate (run before every `bd close`)

Spawn subagent via Task tool:

```
Review task <id> output: <what was done>.
Evaluate on 5 dimensions — mark each PASS or FAIL:
1. Correctness: does it match the acceptance criteria?
2. Security: no new vulnerabilities introduced?
3. Edge cases: null/empty/boundary inputs handled?
4. Tests: behaviour verified by tests or manual check?
5. Completeness: nothing left TODO or half-done?

Output: overall PASS (≥4/5) or FAIL.
If FAIL: list findings as "file:line — issue — fix".
Default FAIL if uncertain on any P0/P1 dimension.
```

- PASS (≥4/5) → `bd close <id>` + `checkpoint-write.sh <id>`
- FAIL → fix → re-run (max 2 attempts) → escalate to `scripts/adversarial-verify.js` if still failing
- Skip only for docs-only or config-only tasks
<!-- END BEADS INTEGRATION -->
