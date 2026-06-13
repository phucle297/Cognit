# Phase 2 Implementation Plan — Session Runtime and Reducer

## Goal

Wire session lifecycle (create / list / resume / pause / close / show) and a
pure reducer that rebuilds session state from events + the latest snapshot.

**done_when:** `cognit session resume <id-or-goal>` rebuilds full session state
from `(last snapshot) + (events after it)` and prints rejected hypotheses,
verified conclusions, accepted decisions, last known state, and the timeline.

---

## Scope (in)

- `cognit session {create,list,resume,pause,close,show}` subcommands.
- `cognit snapshot` explicit trigger.
- `cognit append` and `cognit inbox {--watch,--process}` (last phase-1 piece
  Cognit-mej; needed for phase 2 manual + automated testing).
- Pure reducer in `packages/core` (no I/O).
- Snapshot policy: every N events (config-driven, default 100) + on
  `session_close` + explicit `cognit snapshot`.
- `cognit session show` reducer output: rejected hypotheses, verified
  conclusions, accepted decisions, last-known-state, timeline.
- Resume-as-fork: `--fork=true` (default) creates a new session with
  `parent_session_id` and inherits the parent's context summary
  (a one-line: "resumed from <parent goal>; last state: …").

## Scope (out — explicit deferrals)

- Sticky current-session flag. Phase 2 commands always require `--session`
  or operate on the most-recent active session. We add a TODO; full sticky
  state is v0.1.
- Fuse.js fuzzy title match. Phase 2 does exact match on goal (warning on
  multiple matches). Fuse.js is a phase 3 / v0.2 thing.
- Confidence decay, gravity ranking, recovery suggestions. v0.2.
- API server / dashboard. v0.1.

---

## Architecture

### Pure layer (`packages/core`)

```
core/src/
  state.ts         # SessionState + entity types (ObservationState, HypothesisState, ...)
  reducer.ts       # reduce(events: EventRow[], snapshot?: SnapshotState): SessionState
  events.ts        # typed payload decode for each event type (uses PAYLOAD_SCHEMAS_V1)
  index.ts         # re-export
core/test/
  state.test.ts
  reducer.test.ts  # pure unit tests, no DB
```

`SessionState` is the full snapshot of a session — the same shape written to
`state_json` of the `snapshots` table. The reducer is a fold: for each event
in `created_at` order, apply a pure transition function. Skip non-state
events: `project_created`, `actor_registered`, `redaction_applied`,
`constraint_rule_added`, `constraint_rule_applied`, `snapshot_created`.

`SnapshotState` is `SessionState` plus the `event_id` it was taken after.

### DB layer (`packages/db`)

```
db/src/
  session-service.ts   # SessionService: create, list, getByGoalOrId, pause, close, resume
  snapshot-service.ts  # SnapshotService: write, latestForSession, takeIfDue
  layers/live.ts       # compose new Services
  index.ts             # re-export
db/test/
  session-service.test.ts
  snapshot-service.test.ts
  reducer-integration.test.ts
```

The snapshot service takes a `ReduceFn` injection (from core) so the DB
layer doesn't import the reducer logic directly. This keeps core pure and
the DB layer swappable.

### CLI layer (`packages/cli`)

```
cli/src/commands/
  session.ts   # registerSession(program)
  snapshot.ts  # registerSnapshot(program)
  append.ts    # Cognit-mej: cognit append --type --payload --session --actor
  inbox.ts     # Cognit-mej: cognit inbox --watch | --process
cli/src/index.ts   # register the new commands
cli/test/
  session.test.ts
  snapshot.test.ts
  append.test.ts
  inbox.test.ts
```

CLI commands shell out to a small in-process bootstrap that builds a
`Layer<DbConnection | EventStore | SessionService | SnapshotService | Logger>`
from a `--root` path, then runs the effect.

---

## Reducer — state sections (per `plan.xml <state_sections>`)

| Section         | Shape                                                                                 |
| --------------- | ------------------------------------------------------------------------------------- |
| `observations`  | `ReadonlyArray<{ id, text, created_at }>`                                             |
| `findings`      | `ReadonlyArray<{ id, text, related_observation_ids, created_at }>`                    |
| `hypotheses`    | `ReadonlyMap<string, HypothesisState>` (current_state, current_confidence, reason...) |
| `theories`      | `ReadonlyMap<string, TheoryState>`                                                    |
| `experiments`   | `ReadonlyMap<string, ExperimentState>`                                                |
| `decisions`     | `ReadonlyMap<string, DecisionState>`                                                  |
| `conclusions`   | `ReadonlyMap<string, ConclusionState>`                                                |
| `verifications` | `ReadonlyMap<string, VerificationState>` (with rerun chain)                           |
| `artifacts`     | `ReadonlyMap<string, ArtifactState>`                                                  |
| `edges`         | `ReadonlyArray<EdgeState>`                                                            |
| `timeline`      | `ReadonlyArray<EventRow>` (the input, normalized to created_at order)                 |

**State transitions are encoded as pure functions of `(state, event)`.**
Reducer iterates events; each event type has a registered `apply` function
that returns the next state.

---

## Snapshot policy

```
SnapshotService.takeIfDue(sessionId, n, everyN):
  - last = latestForSession(sessionId)
  - if (n - last.event_count) >= everyN: write(snapshot, sessionId, n)

Triggers:
  - appendEvent (via EventStore.append wrapper): if session crosses N
    boundary, take snapshot. We do this in the SessionService or a small
    hook in event-store.ts.
  - session_close: always take a snapshot before flipping status to closed.
  - explicit `cognit snapshot`: take immediately.

Snapshot write = (state_json = reduce(all events).toJson, event_id = latest
event id, event_count = n). Update sessions.last_snapshot_event_id.
```

---

## Resume-as-fork

`cognit session resume <goal-or-id> [--fork=true]`:

1. Resolve `<goal-or-id>`:
   - If matches `/^01[A-Z0-9]{22,}$/` → id; if multiple match, error.
   - Else exact goal match on open sessions; if multiple, pick most recent
     and print warning.
2. Load the target session + its `last_snapshot_event_id` + the tail
   events. Build SessionState via reducer.
3. Compose a one-line context summary from the rebuilt state (rejected
   hypotheses count, verified conclusions count, accepted decisions count,
   last 3 timeline events).
4. If `--fork=true` (default), INSERT a new `sessions` row with
   `parent_session_id = target.id` and `goal = target.goal +
" (resumed <ISO date>)"`. The forked session is the active one going
   forward.
5. Emit a `session_created` event with `parent_session_id` so the event
   log captures the lineage.

---

## CLI command surface

| Command                                                                  | Maps to                                |
| ------------------------------------------------------------------------ | -------------------------------------- |
| `cognit session create "goal" [--parent id]`                             | SessionService.create + append event   |
| `cognit session list [--status X]`                                       | SessionService.list                    |
| `cognit session resume <goal-or-id> [--fork=true]`                       | SessionService.resume (fork or reopen) |
| `cognit session pause`                                                   | SessionService.pause + append event    |
| `cognit session close`                                                   | SessionService.close + snapshot        |
| `cognit session show <goal-or-id>`                                       | reducer + formatter                    |
| `cognit snapshot [--session id]`                                         | SnapshotService.takeNow                |
| `cognit append --type T --payload JSON --session S --actor "name:human"` | EventStore.append                      |
| `cognit inbox --watch` / `--process`                                     | runInboxWatcher / processFile          |

All `append` paths go through `EventStore.append` (one boundary, audit of
record). The CLI just plumbs args.

---

## Per-file change list

### NEW

| File                                           | Purpose                                               |
| ---------------------------------------------- | ----------------------------------------------------- |
| `packages/core/src/state.ts`                   | `SessionState` + entity-state types                   |
| `packages/core/src/reducer.ts`                 | `reduce(events, snapshot?)` pure function             |
| `packages/core/src/events.ts`                  | typed payload decode helpers (re-export of schemas)   |
| `packages/core/test/state.test.ts`             | state shape sanity                                    |
| `packages/core/test/reducer.test.ts`           | pure reducer: hypotheses, decisions, ... transitions  |
| `packages/db/src/session-service.ts`           | `SessionService` (create/list/get/pause/close/resume) |
| `packages/db/src/snapshot-service.ts`          | `SnapshotService` (write, latest, takeIfDue)          |
| `packages/db/test/session-service.test.ts`     | session CRUD + fork                                   |
| `packages/db/test/snapshot-service.test.ts`    | snapshot policy + take on close                       |
| `packages/db/test/reducer-integration.test.ts` | end-to-end: append events → reducer → state matches   |
| `packages/cli/src/commands/session.ts`         | `cognit session ...`                                  |
| `packages/cli/src/commands/snapshot.ts`        | `cognit snapshot`                                     |
| `packages/cli/src/commands/append.ts`          | `cognit append` (Cognit-mej)                          |
| `packages/cli/src/commands/inbox.ts`           | `cognit inbox` (Cognit-mej)                           |
| `packages/cli/src/layer-build.ts`              | shared Layer builder for CLI commands                 |
| `packages/cli/test/session.test.ts`            | CLI integration                                       |
| `packages/cli/test/snapshot.test.ts`           | CLI integration                                       |
| `packages/cli/test/append.test.ts`             | CLI integration (Cognit-mej)                          |
| `packages/cli/test/inbox.test.ts`              | CLI integration (Cognit-mej)                          |

### EDITED

| File                             | Change                                            |
| -------------------------------- | ------------------------------------------------- |
| `packages/core/src/index.ts`     | re-export `state`, `reducer`                      |
| `packages/db/src/index.ts`       | re-export new services                            |
| `packages/db/src/layers/live.ts` | add new services to `leafs` / `DbLive`            |
| `packages/db/src/errors.ts`      | add `UnknownSessionForResume`, `SnapshotNotFound` |
| `packages/cli/src/index.ts`      | register all new commands                         |
| `packages/cli/package.json`      | add `@cognit/db` dep                              |

---

## Acceptance test (the done_when)

End-to-end test in `packages/db/test/reducer-integration.test.ts`:

1. Open a fresh DB.
2. Insert a project + 1 active session.
3. Append: session_created, observation_recorded x3, finding_created x2,
   hypothesis_created, hypothesis_weakened, hypothesis_rejected, experiment_created,
   experiment_completed, conclusion_proposed, conclusion_verified, decision_proposed,
   decision_accepted, snapshot_created (manual), 90 more observation_recorded,
   session_paused.
4. Call `SnapshotService.takeIfDue(sessionId, 100, 100)` — should write a snapshot
   whose `event_id` is the 100th event.
5. Append 5 more events. Call `SessionService.show(sessionId)` — should:
   - Load the snapshot.
   - Replay only events after snapshot (5 events).
   - Return `SessionState` whose `timeline.length === 105` and
     `hypotheses.get(h_id).current_state === "rejected"`.
6. Close the session. Verify a second snapshot was written on close.
7. Call `cognit session resume <id> --fork=true` via the CLI test driver:
   - A new session exists with `parent_session_id = original`.
   - A `session_created` event was appended with the parent id.

---

## Risks

- **Reducer ordering**: events must sort by `(created_at, id)` and the
  reducer must be a _total_ function — every event type is handled, even
  non-state ones. A `default: return state` keeps the fold total; tests
  enumerate every event type and assert "non-state events do not change
  state" so we never silently drop a transition.
- **Snapshot consistency**: `takeIfDue` must be inside the same tx that
  appends the event, otherwise a crash between append and snapshot leaves
  a session with no checkpoint. Phase 2 takes the snapshot on `session_close`
  (which has its own tx) and explicitly via CLI. Auto-snapshot at N events
  fires from a separate background task that re-opens the tx — the
  acceptance test verifies the manual trigger path first; the auto-N
  trigger is a follow-up if the orchestrator can fit it.
- **Re-emit `session_created` on resume-as-fork**: needs an actor. The CLI
  uses `actor: { name: "cognit-cli", type: "system" }` and the project
  bootstrap registers that actor once.
- **JSON state shape**: state_json must be deterministic (sorted keys when
  serialized). Use `JSON.stringify` with a custom replacer that sorts
  object keys. Test that two snapshots of the same state are byte-equal.
- **Inbox/append integration with reducer**: inbox/append still use the
  existing `EventStore.append` (no reducer involvement on write). The
  reducer is a read path. No risk to existing append tests.

---

## Decomposition (bead plan)

Phase 2 epic: `Cognit-<epic>` (Phase 2: Session Runtime and Reducer).

| Bead | Title                                                                                    | Depends on | Type  |
| ---- | ---------------------------------------------------------------------------------------- | ---------- | ----- |
| `2a` | Reducer state types + pure `reduce()` in core                                            | —          | task  |
| `2b` | Reducer unit tests (every event type, snapshot restore + tail replay)                    | 2a         | task  |
| `2c` | `SessionService` in db: create / list / getByGoalOrId / pause / close                    | 2a         | task  |
| `2d` | `SessionService` tests                                                                   | 2c         | task  |
| `2e` | `SessionService.resume` (fork or reopen) + `session show` reducer view                   | 2a, 2c     | task  |
| `2f` | `SnapshotService` in db: write / latestForSession / takeIfDue                            | 2a         | task  |
| `2g` | Snapshot policy integration: explicit trigger + on-close (auto-N deferred)               | 2c, 2f     | task  |
| `2h` | CLI `cognit append` + `cognit inbox` (Cognit-mej, the last phase-1 piece)                | —          | task  |
| `2i` | CLI `cognit session {create,list,resume,pause,close,show}` + `cognit snapshot`           | 2c, 2e, 2f | task  |
| `2j` | End-to-end test: append 100+ events, snapshot, resume-as-fork, state matches expectation | 2g, 2i     | task  |
| `2k` | Phase 2 docs in plan.xml (no plan changes; add a phase-2-results md) + commit + push     | 2j         | chore |

Auto-N snapshot trigger is _deferred_ behind `2g` if it fits in the cycle;
otherwise it becomes a phase-2.5 bead in a follow-up commit.

---

## Out-of-cycle deferrals (filed as follow-up beads)

- Sticky current-session flag (defer to v0.1).
- Fuse.js fuzzy match (defer to v0.2 or phase 3).
- Auto-N snapshot trigger (defer to phase 2.5; manual + on-close ship first).
- Snapshot file mirror to `.cognit/snapshots/<id>.json` (defer; in-DB
  `state_json` is the source of truth for v0).
- Recovery suggestions, gravity, confidence decay (v0.2).
