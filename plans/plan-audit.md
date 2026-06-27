# Plan-Audit (Phase 0)

Read-only snapshot of `/home/permees/Projects/github.com/phucle297/Cognit/`
after the README/docs restructure rounds (3 rounds of user feedback
applied; tree uncommitted). Scope: drift between code, docs, and
README that requires planned remediation beyond what was done.

## Working tree state

```
M  README.md                                     (442 lines, post-restructure)
M  apps/cli/package.json                         (added dev script)
M  apps/cli/src/paths.ts                         (3-line shim → @cognit/core/paths)
M  apps/server/package.json                      (workspace:*)
M  apps/server/src/index.ts                      (import @cognit/core/paths)
M  docs/hooks/README.md                          (Common behavior section)
M  docs/hooks/{claude-code,codex,opencode,gemini-cli}.md
M  packages/core/package.json                    (./paths export entry)
M  packages/core/src/index.ts                    (./paths.js re-export)
M  packages/sdk/package.json                     (typed exports map)
M  packages/sdk/src/index.ts                     (PHASE=0 → re-exports)
M  packages/wrap/src/index.ts                    (WRAP_SCHEMA_VERSION 1.1.0 → 1.2.0)

?? docs/architecture.md
?? docs/cli.md
?? docs/configuration.md
?? docs/dashboard.md
?? docs/data-model.md
?? docs/events.md
?? docs/getting-started.md
?? docs/hooks.md
?? docs/storage.md
?? hooks/                                        (claude-code, codex, opencode, gemini-cli)
?? packages/core/src/paths.ts                    (canonical path helpers)

D  docs/phase-6.8-results.md
D  docs/phase-6.8.2-results.md
D  docs/phase-7-results.md
D  docs/phase-7-screenshots/
D  docs/phase-8-results.md
D  docs/phase-9-audit.md
D  docs/superpowers/plans/2026-06-18-phase-6.8.2-dashboard-redesign.md
D  docs/superpowers/plans/2026-06-19-phase-7-recovery-engine.md
D  docs/superpowers/plans/2026-06-19-phase-8-gravity-constraint.md
D  docs/superpowers/specs/2026-06-18-phase-6.8.2-dashboard-redesign-design.md
D  docs/superpowers/specs/2026-06-22-gateway-multimodal-design.md
```

Typecheck: `pnpm typecheck` → 20/20 PASS (cached).

## Drift catalogue (post-restructure, code-side)

### D1. `schema_version=1.1.0` in wrap test fixture

`packages/wrap/test/index.test.ts:266` — test name and assertion:

```ts
it("stamps schema_version=1.1.0 and a per-event ULID", async () => {
  // ... expects schema_version: "1.1.0"
});
```

Drift: `packages/wrap/src/index.ts:72` (and `:91-102`) bumped
`WRAP_SCHEMA_VERSION` to `"1.2.0"` and uses field name `version`
(no underscore). The wrap test still asserts the old literal +
old field name. Test passes only because the wrap module under
test is the source of the field, not the test's own assertion.
Will start failing the moment the test re-validates against the
canonical envelope schema.

### D2. `cognit init --shell` documented, not implemented

Docs (`docs/cli.md:90-93`, `docs/hooks/README.md`,
`docs/getting-started.md`) reference:

```bash
eval "$(cognit init --shell)"
```

But `apps/cli/src/commands/init.ts:32` shows:

```ts
export function registerInit(program: Command): void {
  // ... no --shell flag defined anywhere
}
```

Grep confirms: zero `--shell` references in `apps/cli/src/`. The
shell-export snippet is documented as a feature that does not
exist. Three CLI users following the docs hit "unknown option".

### D3. Hook scripts referenced in docs but not shipped

- `docs/hooks/gemini-cli.md:31, 32, 64` reference
  `hooks/gemini-cli/gemini-post.sh`.
- `docs/hooks/codex.md:31` references `codex-pre.sh`.
- `hooks/gemini-cli/` ships only `gemini-hooks.json`.
- `hooks/codex/` ships only `codex-post.sh`.

The docs claim the post/pre scripts as the wiring reference but
the install commands in the same docs point at files that do not
exist. Two choices per phase: ship the scripts, or remove the
references.

### D4. Phase E / Phase G references are stale

- `hooks/opencode/cognit.ts:101, 103` — "Phase E ships only…",
  "deferred to Phase G…".
- `hooks/claude-code/cc-pre.sh:28` — "per the deferred Phase G plan…".
- `docs/hooks/{codex,gemini-cli,opencode}.md` — multiple "Phase G
  companion" references.

The project is no longer at Phase E or G. These comments leak
roadmap state into shipped code/docs. Drift.

### D5. Theory / Experiment — code first-class, README soft-deprecated

Code (all uncommitted before this round, untouched by restructure):

- `packages/core/src/state.ts:125` `TheoryState`
- `packages/core/src/state.ts:137` `ExperimentState`
- `packages/core/src/reducer.ts:390-462, 502` — Theory + Experiment
  reducer branches
- `apps/cli/src/commands/theory.ts` (240 lines, 4 subcommands)
- `apps/cli/src/commands/experiment.ts` (240 lines, 2 subcommands)
- `packages/db/src/event-schema.ts` — `TheoryCreatedPayload`,
  `TheoryUpdatedPayload`, `TheoryMergedPayload`,
  `TheoryArchivedPayload`, `ExperimentCreatedPayload`,
  `ExperimentCompletedPayload`

README now soft-deprecates: excludes from canonical flow, excludes
from concept table, points at `docs/cli.md` "Advanced lifecycle
commands". Drift between README promotion and code first-class
status. Three resolution paths: hard-remove (public API change,
needs explicit approval), soft-deprecate (mark experimental in
CLI, keep code), or revert README and re-promote.

### D6. Source-of-truth pattern not extended

`packages/core/src/paths.ts` is the canonical helper; `apps/cli` is
the only consumer app. Other candidates not yet migrated:

- `packages/core/src/config.ts` — `defaultConfig` lives here; CLI
  imports directly. Some CLI commands still hard-code defaults.
- Event-name literals — `WrapEnvelopeType` lives in
  `packages/wrap/src/index.ts` but producer scripts and CLI
  commands each re-declare the union (4+ copies).
- Schema table / column name constants — `packages/db/src/schema/tables.ts`
  exports a `TABLES_DDL` constant but no per-table name constants.
  Multiple CLI files query by raw string `"events"`, `"sessions"`.
- `COGNIT_SUBDIRS`, `COGNIT_FILES` — already in
  `packages/core/src/paths.ts`, good. But `apps/cli/src/yaml-io.ts`
  has its own `.cognit/` content templates.

User explicitly called this out as "the right direction; keep
applying it" in the previous round.

### D7. No automated tests for new code

Code added/modified without tests:

- `packages/core/src/paths.ts` — 7 exports, zero tests.
- `apps/cli/src/paths.ts` shim — zero tests.
- `hooks/claude-code/{cc-post.sh,cc-pre.sh}` — only manual smoke
  test in `/tmp` (verified v1.2.0 envelope lands, mode 0o600, no
  `.tmp` leftover). Not in CI.
- `hooks/codex/codex-post.sh` — same.
- `hooks/opencode/cognit.ts` — same.

Test files exist: `apps/cli/test/paths.test.ts` (covers old cli
paths only). No test exercises the new core/paths or the hooks.

### D8. README → docs link sanity

README references 9 doc files. All exist post-restructure.
Verify-by-grep below.

```
README.md → docs/getting-started.md      ✓ exists
README.md → docs/cli.md                  ✓ exists
README.md → docs/hooks.md                ✓ exists
README.md → docs/hooks/README.md         ✓ exists
README.md → docs/architecture.md         ✓ exists
README.md → docs/storage.md              ✓ exists
README.md → docs/data-model.md           ✓ exists
README.md → docs/dashboard.md            ✓ exists
README.md → docs/configuration.md        ✓ exists
README.md → docs/events.md               ✓ exists
```

No drift here.

## Out of scope (already resolved in prior rounds)

- 11-table list vs README — README now references docs/storage.md
  without listing tables (D-resolved).
- Port 6971 vs 6970 — README + dashboard.md now distinguish the
  three URLs (Vite dev 5173, Hono loopback 6971 internal, docker
  publish 6970). (D-resolved)
- `docs/hooks/<provider>/*.sh` install path vs `hooks/<provider>/*.sh`
  source — resolved by move.
- Envelope `schema_version` → `version` rename — resolved for docs
  + scripts. Only wrap test fixture still drifts (D1).

## What this audit is NOT

- Not a code change. No modifications planned in Phase 0.
- Not a fix. Each drift above is resolved by a phase in `plan.xml`.
- Not exhaustive of every typo or nit. Drift list is bounded to
  items a reviewer can act on.

## Next step

`plan.xml` next to this file. 8 phases (A-H) + this audit (0).
Each phase lists AC, owner file scope, and verification.
