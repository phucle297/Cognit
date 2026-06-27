# CLI reference

The `cognit` command is a single Commander program declared in
`apps/cli/src/index.ts:33`. Two globals are attached before the subcommands
(`index.ts:45` for `--json` and `index.ts:56` for `--root <path>`); both
are read inside the action via `command.optsWithGlobals()`, so the order
`cognit --root /data init` and `cognit init --root /data` hit the same
code path.

The subcommands currently registered in `apps/cli/src/index.ts:61-89`
are listed below. The registry may grow over time, so treat this table
as a snapshot, not a fixed count. Each lives in its own file under
`apps/cli/src/commands/`.

## Lifecycle

| # | Subcommand    | Source                                    | Purpose                                                                                                  |
|---|---------------|-------------------------------------------|----------------------------------------------------------------------------------------------------------|
| 1 | `init`        | `apps/cli/src/commands/init.ts:1`         | Initialise a local Cognit project (creates `.cognit/` tree, writes `cognit.yaml`, adds `.gitignore`).    |
| 2 | `config`      | `apps/cli/src/commands/config.ts:1`       | Show or edit the local `cognit.yaml`.                                                                    |
| 3 | `env`         | `apps/cli/src/commands/env.ts:1`          | Print hook-relevant env vars (e.g. `$COGNIT_INBOX`) for the current project. Read-only, no side effects. |
| 4 | `session`     | `apps/cli/src/commands/session.ts:1`      | Manage sessions: create / list / show / resume / close / fork.                                           |

## Event authoring

| #  | Subcommand   | Source                                          | Purpose                                                                                  |
|----|--------------|-------------------------------------------------|------------------------------------------------------------------------------------------|
| 4  | `snapshot`   | `apps/cli/src/commands/snapshot.ts:1`           | Take (or return the existing) snapshot for a session.                                     |
| 5  | `append`     | `apps/cli/src/commands/append.ts:1`             | Append a single raw event to a session.                                                  |
| 6  | `observe`    | `apps/cli/src/commands/observation.ts:1`        | Record an `observation_recorded` event.                                                  |
| 7  | `finding`    | `apps/cli/src/commands/finding.ts:1`            | Record a `finding_created` event.                                                        |
| 8  | `hypothesis` | `apps/cli/src/commands/hypothesis.ts:1`         | Hypothesis lifecycle: propose / weaken / reject / promote (4-state).                     |
| 9  | `theory`     | `apps/cli/src/commands/theory.ts:1`             | **Experimental** — Theory lifecycle: `theory_created`, `theory_updated`, `theory_merged`, `theory_archived`. Rarely needed for canonical investigation flow; emits a one-shot stderr warning unless `COGNIT_QUIET_DEPRECATIONS=1`.|
| 10 | `experiment` | `apps/cli/src/commands/experiment.ts:1`         | **Experimental** — Experiment lifecycle: `experiment_created`, `experiment_completed`. Rarely needed for canonical investigation flow; emits a one-shot stderr warning unless `COGNIT_QUIET_DEPRECATIONS=1`.|
| 11 | `decision`   | `apps/cli/src/commands/decision.ts:1`           | Decisions: propose, accept, reject, supersede (4-state lifecycle).                       |
| 12 | `conclusion` | `apps/cli/src/commands/conclusion.ts:1`         | Conclusion lifecycle: propose / verify / reject.                                         |
| 13 | `verify`     | `apps/cli/src/commands/verification.ts:1`       | Verification lifecycle: run (default), cancel, pass, fail, error, rerun.                 |
| 14 | `artifact`   | `apps/cli/src/commands/artifact.ts:1`           | Artifact lifecycle: add (`artifact_attached`).                                           |
| 15 | `edge`       | `apps/cli/src/commands/edge.ts:1`               | Add or list edges between entities in a session (`edge_created` events).                 |
| 16 | `constraint` | `apps/cli/src/commands/constraint.ts:1`         | Manage user-defined constraint rules.                                                    |
| 17 | `redaction`  | `apps/cli/src/commands/redaction.ts:1`          | Dry-run redaction against the built-in + user pattern set.                               |
| 18 | `inbox`      | `apps/cli/src/commands/inbox.ts:1`              | Watch or process the local inbox (`.cognit/inbox/`). See `docs/hooks/README.md`.         |
| 19 | `events`     | `apps/cli/src/commands/events.ts:1`             | List events for a session (optionally follow new events).                                |
| 20 | `wrap`       | `apps/cli/src/commands/wrap.ts:1`               | Spawn a worker command and translate its output into inbox envelopes.                    |

## Inspection, export, recovery

| #  | Subcommand     | Source                                            | Purpose                                                                                       |
|----|----------------|---------------------------------------------------|-----------------------------------------------------------------------------------------------|
| 21 | `schema-dump`  | `apps/cli/src/commands/schema-dump.ts:1`          | Print the v1 JSON envelope shape as TypeScript types.                                         |
| 22 | `recovery`     | `apps/cli/src/commands/recovery.ts:1`             | Read a v0.2 recovery envelope, or fuzzy-search sessions.                                      |
| 23 | `gc`           | `apps/cli/src/commands/gc.ts:1`                   | Garbage-collect stale artifacts past `cleanup.artifact_max_age_days`; archive / delete / keep. |
| 24 | `export`       | `apps/cli/src/commands/export.ts:1`               | Export the current project to a `tar.gz` bundle (manifest + `cognit.yaml` + `cognit.db` + optional `artifacts/`). |
| 25 | `import`       | `apps/cli/src/commands/import.ts:1`               | Import a `tar.gz` bundle produced by `cognit export` (`skip` / `overwrite` / `fork`).          |

## LLM and runtime surfaces

| #  | Subcommand   | Source                                          | Purpose                                                                                                                |
|----|--------------|-------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| 26 | `agent`      | `apps/cli/src/commands/agent.ts:1`              | Drive the AI supervisor loop.                                                                                          |
| 27 | `ask`        | `apps/cli/src/commands/ask.ts:1`                | One-shot LLM query routed via the LiteLLM gateway configured in `cognit.yaml → llm.*`.                                 |
| 28 | `server`     | `apps/cli/src/commands/server.ts:1`             | Spawn the Hono server in `apps/server` (loopback by default, shares `cognit.db` with the CLI).                        |
| 29 | `dashboard`  | `apps/cli/src/commands/dashboard.ts:1`          | Run the Vite dashboard SPA (host: `127.0.0.1:5173`; local default URL is `http://localhost:6971`, or `--docker` profile which publishes the container's port to host `:6970` — see `docs/dashboard.md`). |

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
- Documents how to publish `$COGNIT_INBOX` to hook scripts. A bare
  `cognit init` does NOT touch your environment — a child process
  cannot mutate the parent shell's env. To export
  `$COGNIT_INBOX=<projectRoot>/.cognit/inbox` in the current shell,
  run `eval "$(cognit env --shell)"` (this prints an `export`
  snippet to stdout that the shell evaluates). `cognit env` is a
  separate subcommand (see the lifecycle table above) precisely so
  `init` keeps its single bootstrap purpose. Without an explicit
  override, every producer script resolves the inbox via
  `findProjectRoot` → `<projectRoot>/.cognit/inbox/` (project-relative
  from the script's CWD), so most users do not need the `--shell`
  form at all.

`init` is idempotent. The docker `init` service runs it on every
`docker compose up`; re-running against an already-initialised
project prints "already exists; nothing to do" and exits 0.

## Global flags

- `--json` — every command's stdout switches to the stable v1 envelope
  `{ version: 1, kind, data }`. Registered in `apps/cli/src/index.ts:45`.
- `--root <path>` — project root for this invocation (default: `$COGNIT_ROOT`
  or `process.cwd()`). Registered in `apps/cli/src/index.ts:56`.
- `--version` — printed from the Commander program header (`index.ts:38`).