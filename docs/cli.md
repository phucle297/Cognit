# CLI reference

The `cognit` command is a single Commander program declared in
`apps/cli/src/index.ts` (the `program` symbol). Two globals are
attached before the subcommands (`--json` and `--root <path>`); both
are read inside the action via `command.optsWithGlobals()`, so the
order `cognit --root /data init` and `cognit init --root /data` hit
the same code path.

The subcommands currently registered in
`apps/cli/src/index.ts::registerAll` are listed below. The registry
may grow over time, so treat this table as a snapshot, not a fixed
count. Each lives in its own file under `apps/cli/src/commands/`.

## Lifecycle

| # | Subcommand    | Source                                    | Purpose                                                                                                  |
|---|---------------|-------------------------------------------|----------------------------------------------------------------------------------------------------------|
| 1 | `init`        | `apps/cli/src/commands/init.ts`           | Initialise a local Cognit project (creates `.cognit/` tree, writes `cognit.yaml`, adds `.gitignore`).    |
| 2 | `config`      | `apps/cli/src/commands/config.ts`         | Show or edit the local `cognit.yaml` (flags: `--show`, `--edit`).                                        |
| 3 | `env`         | `apps/cli/src/commands/env.ts`            | Print hook-relevant env vars (`$COGNIT_INBOX`, `$COGNIT_SESSION_ID`) for the current project.            |
| 4 | `session`     | `apps/cli/src/commands/session.ts`        | Manage sessions: create / list / show / resume / close / fork.                                           |

## Event authoring

| #  | Subcommand   | Source                                          | Purpose                                                                                  |
|----|--------------|-------------------------------------------------|------------------------------------------------------------------------------------------|
| 5  | `snapshot`   | `apps/cli/src/commands/snapshot.ts`             | Take (or return the existing) snapshot for a session.                                     |
| 6  | `append`     | `apps/cli/src/commands/append.ts`               | Append a single raw event to a session.                                                  |
| 7  | `observe`    | `apps/cli/src/commands/observation.ts`          | Record an `observation_recorded` event.                                                  |
| 8  | `finding`    | `apps/cli/src/commands/finding.ts`              | Record a `finding_created` event.                                                        |
| 9  | `hypothesis` | `apps/cli/src/commands/hypothesis.ts`           | Hypothesis lifecycle: propose / weaken / reject / promote (4-state).                     |
| 10 | `theory`     | `apps/cli/src/commands/theory.ts`               | **Experimental** — Theory lifecycle: `theory_created`, `theory_updated`, `theory_merged`, `theory_archived`. Rarely needed for canonical investigation flow; emits a one-shot stderr warning unless `COGNIT_QUIET_DEPRECATIONS=1`.|
| 11 | `experiment` | `apps/cli/src/commands/experiment.ts`           | **Experimental** — Experiment lifecycle: `experiment_created`, `experiment_completed`. Rarely needed for canonical investigation flow; emits a one-shot stderr warning unless `COGNIT_QUIET_DEPRECATIONS=1`.|
| 12 | `decision`   | `apps/cli/src/commands/decision.ts`             | Decisions: propose, accept, reject, supersede (4-state lifecycle).                       |
| 13 | `conclusion` | `apps/cli/src/commands/conclusion.ts`           | Conclusion lifecycle: propose / verify / reject.                                         |
| 14 | `verify`     | `apps/cli/src/commands/verification.ts`         | Verification lifecycle: run (default), cancel, pass, fail, error, rerun.                 |
| 15 | `artifact`   | `apps/cli/src/commands/artifact.ts`             | Artifact lifecycle: add (`artifact_attached`).                                           |
| 16 | `edge`       | `apps/cli/src/commands/edge.ts`                 | Add or list edges between entities in a session (`edge_created` events).                 |
| 17 | `constraint` | `apps/cli/src/commands/constraint.ts`           | Manage user-defined constraint rules.                                                    |
| 18 | `redaction`  | `apps/cli/src/commands/redaction.ts`            | Dry-run redaction against the built-in + user pattern set.                               |
| 19 | `inbox`      | `apps/cli/src/commands/inbox.ts`                | Watch or process the local inbox (`.cognit/inbox/`). See `docs/hooks/README.md`.         |
| 20 | `events`     | `apps/cli/src/commands/events.ts`               | List events for a session (optionally follow new events).                                |
| 21 | `wrap`       | `apps/cli/src/commands/wrap.ts`                 | Spawn a worker command and translate its output into inbox envelopes.                    |

## Inspection, export, recovery

| #  | Subcommand     | Source                                            | Purpose                                                                                       |
|----|----------------|---------------------------------------------------|-----------------------------------------------------------------------------------------------|
| 22 | `schema-dump`  | `apps/cli/src/commands/schema-dump.ts`            | Print the v1 JSON envelope shape as TypeScript types.                                         |
| 23 | `recovery`     | `apps/cli/src/commands/recovery.ts`               | Read a v0.2 recovery envelope, or fuzzy-search sessions.                                      |
| 24 | `gc`           | `apps/cli/src/commands/gc.ts`                     | Garbage-collect stale artifacts past `cleanup.artifact_max_age_days`; archive / delete / keep. |
| 25 | `export`       | `apps/cli/src/commands/export.ts`                 | Export the current project to a `tar.gz` bundle (manifest + `cognit.yaml` + `cognit.db` + optional `artifacts/`). |
| 26 | `import`       | `apps/cli/src/commands/import.ts`                 | Import a `tar.gz` bundle produced by `cognit export` (`skip` / `overwrite` / `fork`).          |

## LLM and runtime surfaces

| #  | Subcommand   | Source                                          | Purpose                                                                                                                |
|----|--------------|-------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| 27 | `agent`      | `apps/cli/src/commands/agent.ts`                | Drive the AI supervisor loop.                                                                                          |
| 28 | `ask`        | `apps/cli/src/commands/ask.ts`                  | One-shot LLM query routed via the LiteLLM gateway configured in `cognit.yaml → llm.*`.                                 |
| 29 | `server`     | `apps/cli/src/commands/server.ts`               | Spawn the Hono server in `apps/server` (loopback by default, shares `cognit.db` with the CLI).                        |
| 30 | `dashboard`  | `apps/cli/src/commands/dashboard.ts`            | Run the Vite dashboard SPA (host: `127.0.0.1:5173`; local default URL is `http://localhost:5173`, or `--docker` profile which publishes the container's port to host `:6970` — see `docs/dashboard.md`). |

## `cognit init` — what it does for you

`cognit init` (`apps/cli/src/commands/init.ts`) bootstraps a project so
all other subcommands have something to read. In one call it:

- Creates `.cognit/` at the resolved project root, plus the standard
  subdirectories (`COGNIT_SUBDIRS` from `apps/cli/src/paths.ts`):
  - `.cognit/inbox/` — drop folder for envelopes (see
    `docs/hooks/README.md`).
  - `.cognit/artifacts/` — content-addressed files attached to events
    (`artifacts/` table, sha256-indexed). Has a `curated/` subfolder
    surfaced in the dashboard.
  - `.cognit/snapshots/` — frozen `SessionState` JSON projections.
  - `.cognit/archive/` — artifacts past the `cleanup.artifact_max_age_days`
    threshold.
- Writes `.cognit/cognit.yaml` from `defaultConfig(projectName)`
  (`packages/core/src/config.ts`); everything except `project.name` has
  a schema default.
- Writes `.cognit/.gitignore` (`apps/cli/src/yaml-io.ts:42`,
  `writeCognitGitignore`) ignoring `cognit.db`, `cognit.db-journal`,
  `cognit.db-wal`, `cognit.db-shm`, `inbox/`, `snapshots/`, `archive/`
  — committing the `cognit.yaml` config but keeping runtime state out
  of version control.
- Bootstraps the SQLite DB at `.cognit/cognit.db` and inserts the
  `projects` row via `ProjectService.ensure` (idempotent — re-running
  `init` is a no-op unless `--force` is passed).
- Documents how to publish `$COGNIT_INBOX` / `$COGNIT_SESSION_ID`
  to hook scripts. A bare `cognit init` does NOT touch your
  environment — a child process cannot mutate the parent shell's
  env. To export both vars in the current shell, run
  `eval "$(cognit env --shell)"` (this prints `export` snippets to
  stdout that the shell evaluates). `cognit env` is a separate
  subcommand (see the lifecycle table above) precisely so `init`
  keeps its single bootstrap purpose. Without an explicit override,
  every producer script resolves the inbox via `findProjectRoot` →
  `<projectRoot>/.cognit/inbox/` (project-relative from the
  script's CWD), so most users do not need the `--shell` form at
  all.

`init` is idempotent. Re-running against an already-initialised
project prints "already exists; nothing to do" and exits 0.

## Global flags

- `--json` — every command's stdout switches to the stable v1 envelope
  `{ version: 1, kind, data }`. Registered in `apps/cli/src/index.ts`
  on the `program` symbol.
- `--root <path>` — project root for this invocation (default: `$COGNIT_ROOT`
  or `process.cwd()`). Registered in `apps/cli/src/index.ts` on the
  `program` symbol.
- `--version` — printed from the Commander program header.

## Advanced lifecycle commands

The canonical investigation flow uses `observe → hypothesis →
verify → conclusion → decision`. Two more event types exist for
multi-step reasoning that needs explicit evidence collection or
higher-level model assembly:

- **`theory`** — the `theory_created` / `theory_updated` /
  `theory_merged` / `theory_archived` lifecycle. A Theory aggregates
  multiple Hypotheses into a single named model that the
  investigation as a whole can build on, merge, or retire.
- **`experiment`** — the `experiment_created` /
  `experiment_completed` lifecycle. An Experiment is a typed,
  bounded run that collects evidence against a Hypothesis (distinct
  from `cognit verify`, which is a single command run; an Experiment
  spans multiple verifications plus intermediate observations).

Both ship behind the `COGNIT_QUIET_DEPRECATIONS=1` env var: the
first invocation per process emits a one-shot stderr warning noting
that they are not part of the canonical flow. Most investigations
do not need them — see the **Event authoring** table for the row
references.