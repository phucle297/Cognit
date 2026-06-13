# Phase 2.5 Plan — Auto-snapshot trigger

## Goal

Wire `SnapshotService.takeIfDue` so it runs on event append (not only on
`session close` or explicit `cognit snapshot`). After phase 2.5, every
Nth event on a session auto-snapshots, keeping the snapshot+tail replay
path bounded by ~N events.

**done_when:** in a project with `session.snapshot_every_n_events: 3`
in `cognit.yaml`, after appending 3 events to an active session, the
`snapshots` table contains a row with `event_count=3` and the
`session show` reducer output is identical to a fold from scratch.

## Epic / subtasks

- Epic: `Cognit-04i`
- 2.5a — `SessionPolicy` service + config plumbing → `Cognit-04i.1`
- 2.5b — `SessionService.appendEvent` + helper refactor → `Cognit-04i.2`
- 2.5c — CLI `append` + inbox use the new method → `Cognit-04i.3`
- 2.5d — Auto-snapshot tests (unit + e2e) → `Cognit-04i.4`
- 2.5e — Phase 2.5 docs + close epic → `Cognit-04i.5`

## Files per subtask

### 2.5a — `SessionPolicy` plumbing

- **NEW** `packages/db/src/session-policy.ts`
  - `SessionPolicy` Context.Tag with shape `{ readonly everyN: number; readonly forkOnResume: boolean }`
  - `SessionPolicyDefault = Layer.succeed(SessionPolicy)({ everyN: 100, forkOnResume: true })`
- **MODIFY** `packages/db/src/index.ts` — export `SessionPolicy`, `SessionPolicyDefault`
- **MODIFY** `packages/db/src/layers/live.ts` — `DbLive(dbPath, policy?)` accepts optional `SessionPolicy`; default to `SessionPolicyDefault`. Add to the output Layer's R channel (or use it as a private dep).
- **MODIFY** `packages/cli/src/commands/init.ts` — no change (default config already has `session.snapshot_every_n_events: 100`)
- **MODIFY** `packages/cli/src/layer-build.ts` — accept an optional `SessionPolicy` parameter, build from `readConfig(root)`'s `session` section
- **MODIFY** `packages/cli/src/commands/append.ts` / `inbox.ts` / `session.ts` / `snapshot.ts` — read cognit.yaml once at command entry, build a `SessionPolicy`, pass to `buildAppLayer(root, policy)`

### 2.5b — `SessionService.appendEvent` + helper

- **MODIFY** `packages/db/src/session-service.ts`
  - Add input type `SessionAppendEventInput = { sessionId, type, payload, actor, source?, artifactRefs?, causationId?, correlationId?, confidence?, parentVerificationId?, linkedHypothesisId? }`
  - Add a private helper `_appendAndMaybeSnapshot(input, actor, snapshotKind)`:
    1. Append via `store.append`
    2. Count events for the session
    3. Call `snapshots.takeIfDue({ sessionId, currentEventCount: count, everyN: policy.everyN, build: reduce })` if `count > 0`
    4. Log snapshot result, swallow errors
  - Add public `appendEvent(input)`:
    1. Fetch session row
    2. Fail with `UnknownSession` if missing
    3. Fail with `DbError` if status === `"closed"`
    4. Call `_appendAndMaybeSnapshot`
    5. Return `{ event, snapshotTaken: boolean }`
  - Refactor `create` / `pause` / `resume` to call `_appendAndMaybeSnapshot` for their event write step
  - `close` keeps its always-take-snapshot AFTER calling `_appendAndMaybeSnapshot`
  - Update `SessionServiceLive`'s R channel to include `SessionPolicy`

### 2.5c — CLI / inbox switch

- **MODIFY** `packages/cli/src/commands/append.ts`
  - Replace `EventStore.append` with `SessionService.appendEvent`
  - Read cognit.yaml at command entry, build `SessionPolicy`
- **MODIFY** `packages/db/src/inbox.ts`
  - `drainInbox` and `processFile` switch from `store.append` to `SessionService.appendEvent`
  - Resolve session policy from a function arg (caller passes it)
- **MODIFY** `packages/cli/src/commands/inbox.ts`
  - Read cognit.yaml, build policy, pass into `drainInbox` / `runInboxWatcher`

### 2.5d — Tests

- **MODIFY** `packages/db/test/session-service.test.ts`
  - 6 new tests as in the subtask description
  - Test setup: provide a `SessionPolicy` with `everyN: 3` to the test layer
- **MODIFY** `packages/cli/test/append.test.ts`
  - New E2E: init with everyN=3, create session, append 3 events, assert snapshot row exists via direct DB query (read `cognit.db` with better-sqlite3)
- **MODIFY** `packages/db/test/reducer-integration.test.ts`
  - Extend to cover the auto-trigger path (or add a sibling test)

### 2.5e — Docs

- **NEW** `docs/phase-2.5-results.md` mirroring `phase-2-results.md` structure
- **MODIFY** `ARCHITECTURE.md` if any user-visible change in read path
- Commit (do not push without explicit user approval)
- Close epic + subtasks

## New interfaces

```ts
// packages/db/src/session-policy.ts
export interface SessionPolicyShape {
  readonly everyN: number;
  readonly forkOnResume: boolean;
}
export class SessionPolicy extends Context.Tag("@cognit/db/SessionPolicy")<
  SessionPolicy,
  SessionPolicyShape
>() {}
export const SessionPolicyDefault: Layer.Layer<SessionPolicy>;

// packages/db/src/session-service.ts
export interface SessionAppendEventInput {
  readonly sessionId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly actor: { readonly name: string; readonly type: ActorType };
  readonly source?: AppendEventInput["source"];
  readonly artifactRefs?: AppendEventInput["artifactRefs"];
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly confidence?: number;
  readonly parentVerificationId?: string;
  readonly linkedHypothesisId?: string;
}
export interface SessionAppendEventResult {
  readonly event: EventRow;
  readonly snapshotTaken: boolean;
}
```

## Migration order

1. `2.5a` — pure addition (new file, new exports). `DbLive` signature change
   is backward-compatible (`policy?` is optional). No tests broken.
2. `2.5b` — new method on existing service. R-channel widens. Test layer
   must provide `SessionPolicy` for the new tests; existing tests keep
   working with the default.
3. `2.5c` — caller switch. Old `EventStore.append` path still works for
   lifecycle events (kept for backwards compat in case the tests rely on
   it); new path goes through `appendEvent`.
4. `2.5d` — adds tests; no production code change.
5. `2.5e` — docs + close.

Each step is testable in isolation. Phase boundary = `checkpoint-write.sh` +
`git commit` per subtask.

## Risks

- **EventStore signature drift**: `SessionService.appendEvent` mirrors
  `EventStore.append`'s input fields. If `EventStore.append` grows new
  fields, the wrapper must grow them too. Mitigation: keep the input
  type derived from `AppendEventInput`.
- **DbLive API change**: `DbLive(dbPath, policy?)` is additive, not
  breaking. Existing callers (`packages/db/test/*`, CLI) compile cleanly.
- **Inbox policy injection**: `drainInbox` and `runInboxWatcher` need a
  `SessionPolicy` arg. Existing call sites must be updated together
  with the layer-build plumbing.
- **Test-side `SessionPolicy`**: existing 30 SessionService tests may
  start triggering snapshots unintentionally if the default `everyN=100`
  is below their event count. Audit: none of the existing tests push
  > 100 events on a single session in a way that would actually trigger
  > `takeIfDue` (lifecycle tests append 1-2 events each). Risk: low. If
  > it bites, tests can override `SessionPolicy` with `everyN: 999999`.
- **Snapshot write failure on close vs every-N**: `close` always writes
  one. The every-N trigger may have already written. Acceptable: two
  snapshots within close range is fine; the next read picks the latest.
