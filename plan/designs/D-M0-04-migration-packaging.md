# D-M0-04 — Server migration packaging

## Problem

`packages/db` loads SQL migration files from disk next to the bundled module. CLI build runs `copy-migrations` into `apps/cli/dist/migrations`. Server build does not. Running server from dist fails with ENOENT.

## Current implementation

- `packages/db/src/schema/migrations.ts` `readFileSync(join(here, "migrations", file))`.
- CLI package.json script copies SQL.
- Server tsup bundles TS only.

## Alternatives considered

| Option | Pros | Cons |
|--------|------|------|
| A. **Copy SQL next to server dist** (mirror CLI) | Minimal change | Must keep scripts in sync |
| B. Inline SQL strings into migrations.ts | Single artifact | Larger TS; noisier diffs |
| C. Change load path to packages/db source | Dev-only | Breaks installed layouts |

## Chosen solution

**A** for symmetry with CLI:

1. Add `copy-migrations` script to `@cognit/server` (same source path as CLI).
2. `build`: `tsup && pnpm run copy-migrations`.
3. Dockerfile.server: ensure copy step runs (verify).
4. Optional follow-up (not required): share a root script to avoid drift.

Reject B unless packaging still fails in edge environments.

## Migration strategy

- Dev rebuild required. No DB data migration.

## Risk

- Docker image misses step. Mitigation: smoke test boot in CI.

## Rollback strategy

- Revert package.json scripts.

## Tests required

- Unit/smoke: after build, `apps/server/dist/migrations/*.sql` exist.
- Boot test: open temp db via server entry or `applyMigrations` from built path.
