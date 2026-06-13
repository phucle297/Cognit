# Phase 2.5 Results — Auto-snapshot trigger

> One-screen summary of what shipped in phase 2.5, what was deferred, and how to verify.

## TL;DR

Phase 2.5 is **done**. The every-N-events snapshot trigger is wired:
`cognit append` and inbox processing now auto-snapshot a session when its
event count crosses `session.snapshot_every_n_events` (default 100), keeping
the snapshot+tail replay window bounded without an explicit `cognit snapshot`.

## Shipped

- **`SessionPolicy` tag** (`packages/db/src/session-policy.ts`).
  Effect `Context.Tag` carrying `{ everyN, forkOnResume }`.
  `SessionPolicyDefault` ships `everyN: 100, forkOnResume: true`.
  Pure `sessionPolicyFromConfig` derives the shape from the on-disk
  `cognit.yaml` `session` section.
- **`DbLive` accepts an optional policy** (`packages/db/src/layers/live.ts`).
  `DbLive(dbPath, policy?)` — additive, no breaking change for existing
  callers.
- **`SessionService.appendEvent` + `_appendAndMaybeSnapshot` helper**
  (`packages/db/src/session-service.ts`).
  New `SessionAppendEventInput` / `SessionAppendEventResult` types.
  `appendEvent` validates the session, then delegates to the private
  `_appendAndMaybeSnapshot` helper which appends, counts events, and
  calls `SnapshotService.takeIfDue` with the current count + `policy.everyN`.
  Returns `{ event, snapshotTaken }` so callers can surface the
  "snapshot: yes/no" line.
- **Lifecycle refactor**: `create` / `pause` / `resume` now go through
  `_appendAndMaybeSnapshot` so they participate in the every-N trigger.
  `close` keeps its always-take-snapshot on top of the every-N path.
- **CLI switch to `appendEvent`**: `packages/cli/src/commands/append.ts`
  builds the policy from `cognit.yaml` at command entry and prints
  `snapshot: yes|no` to stdout.
- **Inbox switch to `appendEvent`**: `packages/db/src/inbox.ts`
  (`drainInbox` / `processFile`) and `packages/cli/src/commands/inbox.ts`
  take a `SessionPolicy` argument and forward it through.

## Bug surfaced and fixed

The inbox pipeline passes an explicit event `id` on each append so a
file that gets re-picked up after a partial rename does not produce a
duplicate row. When the subagent wiring `appendEvent` first ported the
caller, it dropped the `id` field — the `SessionAppendEventInput` type
mirrored most of `AppendEventInput` but not the optional `id`. The
inbox tests then surfaced the regression: re-running `--process` on an
already-moved file inserted a second row because no id was forwarded.

Fix: added `readonly id?: string` to `SessionAppendEventInput` in
`packages/db/src/session-service.ts` and forwarded it to
`EventStore.append`. Regression covered by the inbox
`processFile > parses, appends, and moves a valid file to processed`
unit test.

## Deferred (filed as follow-ups)

- **Background auto-snapshot task.** v0.1 keeps the trigger inline on
  `cognit append` / inbox processing. A background task that scans
  every session is a v0.2 add — not needed while every write path goes
  through `appendEvent`.
- **Sticky current-session flag.** v0.1 follow-up.
- **JSON output mode** for CLI commands. v0.1 follow-up — current
  `snapshot: yes|no` is plain text.
- **Snapshot file mirror** to `.cognit/snapshots/<id>.json`. v0.2; the
  in-DB `state_json` column is the source of truth for v0.

## Test counts

| Package        | Phase 2 end | Phase 2.5 end | Delta |
| -------------- | ----------- | ------------- | ----- |
| `@cognit/db`   | 97          | 103           | +6    |
| `@cognit/cli`  | 36          | 37            | +1    |
| `@cognit/core` | 44          | 44            | 0     |
| **total**      | 177         | 184           | +7    |

`pnpm -r typecheck` clean. All 184 tests pass.

## How to verify

```bash
# 1. Build a fresh project
cd /tmp && rm -rf cognit-demo && mkdir cognit-demo && cd cognit-demo
node /path/to/cognit/packages/cli/src/index.ts init

# 2. Lower the threshold so we can observe the trigger in 3 appends
# Edit .cognit/cognit.yaml and set:
#   session:
#     snapshot_every_n_events: 3

# 3. Create a session and capture its id
node /path/to/cognit/packages/cli/src/index.ts session create "find the bug"
# (copy the session id printed)

# 4. Three appends. The 3rd should print "snapshot: yes".
node /path/to/cognit/packages/cli/src/index.ts append \
  --type observation_recorded --payload '{"text":"saw NPE"}' \
  --session <id>
# stdout: snapshot: no
node /path/to/cognit/packages/cli/src/index.ts append \
  --type observation_recorded --payload '{"text":"traced to reducer"}' \
  --session <id>
# stdout: snapshot: no
node /path/to/cognit/packages/cli/src/index.ts append \
  --type hypothesis_proposed --payload '{"text":"h: Map keys lost on serialise"}' \
  --session <id>
# stdout: snapshot: yes
```

A direct DB query confirms the row:

```bash
sqlite3 .cognit/cognit.db \
  "SELECT session_id, event_count FROM snapshots ORDER BY event_count;"
# expect one row with event_count=3
```

## Architecture notes

- **Inline trigger, not a background task.** The auto-snapshot fires
  from `_appendAndMaybeSnapshot`, which is called by `appendEvent` and
  by the `create` / `pause` / `resume` lifecycle helpers. Every write
  path the user can hit (`cognit append`, `cognit inbox --process`,
  `cognit inbox --watch`) goes through one of these, so the trigger
  runs deterministically inside the same Effect that wrote the event.
  Justification for v0.1: no scheduling infrastructure, no missed
  triggers if the process exits between append and snapshot, and the
  failure mode is the same as the existing on-close trigger — log and
  swallow. A background "scan all sessions" task is a v0.2 add for the
  case where a long-lived inbox watcher needs to coalesce threshold
  crossings across many sessions without an append in flight.
- **`everyN` is per-project, not per-session.** The `SessionPolicy`
  Layer is built once at CLI command entry from `cognit.yaml` and
  threaded through `buildAppLayer`. Changing `snapshot_every_n_events`
  takes effect on the next command invocation.
- **Idempotent appends.** The inbox pipeline passes an explicit `id`
  on each event. The bug-and-fix section above documents why
  `SessionAppendEventInput` mirrors `AppendEventInput.id` — a re-pickup
  of the same file must not insert a second row.
