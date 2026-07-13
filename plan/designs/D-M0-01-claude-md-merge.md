# D-M0-01 — CLAUDE.md merge / no clobber

## Problem

`cognit init` and idempotent re-init overwrite project-root `CLAUDE.md` with Cognit-only content (`apps/cli/src/commands/init.ts`). Projects that already use `CLAUDE.md` for agent rules (beads, conventions, team policy) lose that content silently.

## Current implementation

- Constant `CLAUDE_MD` string written via `fs.writeFile` on first init and on “already exists” path.
- Integration tests assert overwrite on re-init.

## Alternatives considered

| Option | Pros | Cons |
|--------|------|------|
| A. Always overwrite | Instructions always match CLI | Destroys user content |
| B. Write only if missing | Safe | Stale instructions after CLI upgrade |
| C. Sidecar `.cognit/INSTRUCTIONS.md` only | Never touches CLAUDE.md | Weaker Claude Code pickup unless user links it |
| D. **Marked section merge** | Updates Cognit block; preserves rest | Marker discipline required |
| E. Append once, never refresh | Simple | Drift + duplication |

## Chosen solution

**D + optional C fallback:**

1. Define stable markers:
   - `<!-- cognit:start -->` … `<!-- cognit:end -->`
2. On init/re-init:
   - If `CLAUDE.md` missing → write full file with markers wrapping Cognit block.
   - If exists and markers present → replace only the marked region with current Cognit block.
   - If exists and markers absent → **append** marked Cognit block once (do not delete user content). Log a stderr note.
3. Also write `.cognit/INSTRUCTIONS.md` as canonical copy (always overwritten; inside `.cognit/`).
4. Optionally support `AGENTS.md` later; not required for M0.

Do **not** invent multi-tool instruction writers in this PR.

## Migration strategy

- Existing projects: next `cognit init` appends marked block if no markers (may duplicate old Cognit-only full file content once — document `init --force-instructions` later if needed).
- Tests that required full-file equality must switch to “contains marked block” assertions.

## Risk

- Users who relied on full-file replace to refresh may keep stale non-marker files until append. Mitigation: doctor warns if Cognit block version/hash mismatches CLI.

## Rollback strategy

- Revert PR; worst case old overwrite behavior returns.

## Tests required

- init on empty dir creates marked CLAUDE.md.
- init with existing user CLAUDE.md preserves user paragraphs.
- re-init updates marked region only.
- `.cognit/INSTRUCTIONS.md` always matches current template.
- No regression on hooks install path.
