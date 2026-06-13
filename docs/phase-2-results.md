# Phase 2 Results — Session Runtime and Reducer

> One-screen summary of what shipped in phase 2, what was deferred, and how to verify.

## TL;DR

Phase 2 is **done**. The done_when holds: `cognit session resume <id>` rebuilds
the full session state from `(last snapshot) + (events after it)` and prints
rejected hypotheses, verified conclusions, accepted decisions, observations,
findings, and the timeline.

## Shipped

- **Pure reducer** (`packages/core/src/reducer.ts`).
  Total fold over `(created_at, id)` order. Handles every event type
  (state + non-state). Skips non-state events without changing state
  (the fold is _total_). 35 unit tests in `reducer.test.ts`.
- **`SessionState` shape** (`packages/core/src/state.ts`).
  Full session view: observations, findings, hypotheses, theories,
  experiments, decisions, conclusions, verifications, artifacts,
  edges, and the timeline.
- **`SnapshotService`** (`packages/db/src/snapshot-service.ts`).
  `write` / `latestForSession` / `takeIfDue`. Deterministic JSON
  (sorted keys + Map→object on serialize, object→Map on rehydrate).
  10 unit tests.
- **`SessionService`** (`packages/db/src/session-service.ts`).
  `create` / `list` / `getByGoalOrId` / `pause` / `close` / `resume`
  / `show` / `takeSnapshot`. 30 unit tests.
- **`ProjectService`** (`packages/db/src/project-service.ts`).
  Idempotent `ensure({name})` for CLI bootstrap. 9 unit tests.
- **On-close snapshot** (wired in `SessionService.close`).
  Failure is logged but does not roll back the close — the event log
  is the source of truth, the snapshot is a rebuild optimisation.
- **Explicit `cognit snapshot`** (CLI).
  Calls `SessionService.takeSnapshot`, which is idempotent.
- **CLI: `cognit session {create,list,show,resume,pause,close}`** +
  **`cognit snapshot`**. 9 spawn tests.
- **CLI: `cognit append` + `cognit inbox {--process,--watch}`**.
  13 spawn tests.
- **End-to-end integration test** in
  `packages/db/test/reducer-integration.test.ts` — the done_when.
- **CLI E2E for fork** in `packages/cli/test/resume-e2e.test.ts`.

## Bug surfaced and fixed

`SnapshotService.serializeState` originally dropped `Map` contents
(JSON.stringify serialises a Map as `{}` because Object.keys(map) is
`[]`). The fix converts each `Map` to a key-sorted plain object on
write, and `SessionService.show` reverses the conversion via
`rehydrateSessionState`. Regression test in
`snapshot-service.test.ts:386`.

## Bug surfaced and fixed (DbLive)

`DbLive` constructed `DbConnectionLive(dbPath)` once per service,
causing each service to get its own sqlite handle. Worked in unit
tests (where the test layer builds its own shared `dbConn`) but
broke in production. Fixed in `packages/db/src/layers/live.ts:53-97`
— a single shared `dbConn` is now fed to every service.

## Deferred (filed as follow-ups)

- **Auto-N-event snapshot trigger.** Manual (`cognit snapshot`) +
  on-close ship. The every-N trigger is wired in `takeIfDue` and
  tested; it's not yet called from a background task. Phase 2.5.
- **Sticky current-session flag.** Defer to v0.1.
- **Fuse.js fuzzy match** on goal. Defer to v0.2 / phase 3.
- **JSON output mode** for CLI commands. Defer to v0.1.
- **Snapshot file mirror** to `.cognit/snapshots/<id>.json`. Defer;
  in-DB `state_json` is the source of truth for v0.

## Test counts

| Package        | Phase 1 end | Phase 2 end | Delta |
| -------------- | ----------- | ----------- | ----- |
| `@cognit/db`   | 70          | 97          | +27   |
| `@cognit/cli`  | 13          | 36          | +23   |
| `@cognit/core` | 44          | 44          | 0     |
| **total**      | 127         | 177         | +50   |

`pnpm -r typecheck` clean. All 177 tests pass.

## How to verify

```bash
# 1. Build a fresh project
cd /tmp && rm -rf cognit-demo && mkdir cognit-demo && cd cognit-demo
node /path/to/cognit/packages/cli/src/index.ts init
node /path/to/cognit/packages/cli/src/index.ts session create "find the bug"
# (copy the session id printed)
node /path/to/cognit/packages/cli/src/index.ts append \
  --type observation_recorded --payload '{"text":"saw NPE"}' \
  --session <id>
node /path/to/cognit/packages/cli/src/index.ts snapshot --session <id>
node /path/to/cognit/packages/cli/src/index.ts session show <id>
node /path/to/cognit/packages/cli/src/index.ts session resume <id> --fork=true
# Expect: a new session id; events on it are linked to the original via parent_session_id.
```

## Architecture notes

- **`core` stays I/O-free.** The reducer is pure; `db` calls it via
  injection (`build: (events) => reduce(events, initial)` in
  `takeIfDue`). No `core → db` import direction violation.
- **Snapshot determinism.** Object keys sorted at every level; Maps
  serialised to objects by key. Two snapshots of the same state are
  byte-equal — dedup is `state_json === state_json`.
- **Session status is a derived index.** The `sessions` table is
  rebuilt from events by the reducer; CLI ops on status happen via
  `SessionService` and always append a corresponding lifecycle event.
- **Layer composition in `DbLive`.** Single shared `dbConn`; each
  service gets it via `Layer.provide` to satisfy the R-channel. See
  the bug fix in `packages/db/src/layers/live.ts`.
