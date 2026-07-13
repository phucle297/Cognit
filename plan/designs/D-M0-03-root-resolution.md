# D-M0-03 — Unified `--root` / `COGNIT_ROOT` resolution

## Problem

Help text claims `--root` applies to every subcommand. Only some commands call `optsWithGlobals()` / `COGNIT_ROOT`. Core memory verbs (`observation`, `decision`, `continue`, …) use `opts.root ?? requireProjectRoot()` and therefore ignore global `--root` and often env.

## Current implementation

- Program-level `.option("--root …")` in `apps/cli/src/index.ts`.
- Correct pattern in `init`, `doctor`, `env`, `reset`.
- Incorrect pattern in observation/decision/continue and others.

## Alternatives considered

| Option | Pros | Cons |
|--------|------|------|
| A. Document “must cd into project” | No code | Lies vs current help |
| B. **Central resolver used everywhere** | One truth | Touch many files |
| C. Middleware preAction sets process chdir | Convenient | Surprising cwd side effects |

## Chosen solution

**B:**

1. Add `resolveProjectRoot(command, opts?): string` in `apps/cli/src/paths.ts` or small `root.ts`:
   - order: explicit opts.root → `command.optsWithGlobals().root` → `process.env.COGNIT_ROOT` → `requireProjectRoot()` / cwd walk.
2. Replace all root resolutions with this helper.
3. Keep subcommand `--root` flags for local discoverability but same helper.
4. Fix alias re-parse paths if they drop globals.

## Migration strategy

- Behavior expands (more inputs work). No data migration.
- Backwards compatible for cwd usage.

## Risk

- Miss one command → residual bug. Mitigation: grep audit + integration test matrix for `--root` and `COGNIT_ROOT` on public verbs.

## Rollback strategy

- Revert PR.

## Tests required

- For each public write/read verb: run from `/tmp` with `--root <project>` and with `COGNIT_ROOT`.
- Global form `cognit --root <p> observation …` and trailing form if supported.
- Negative: no root and outside project → exit code 2 (align with M2-01 later).
