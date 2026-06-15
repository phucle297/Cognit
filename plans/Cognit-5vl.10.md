# Cognit-5vl.10 — 3d Hono server (gap-closure plan, v2)

Status: in_progress. Owner: PerMees. Plan written 2026-06-15. Revised after plan-review FAIL (dropped α view.ts and γ layer-build — gold-plating, churn).

## Reality vs phase-3.md 3d spec

3d scaffold already exists (apps/server/src/{index,auth,bus,envelope,event-queries,sse}.ts + routes/{healthz,sessions,events}.ts + test/server.test.ts). Done-when items green: Hono boot, /healthz 200 no-auth, /sessions list, /sessions/:id/state, /sessions/:id/events, /events/stream SSE replay-then-live, /events/feed, POST /events via SessionService.appendEvent, bearer auth wired.

**Real gap = 6 items.** Score: SMALL (F=4-5, C=2: db inbox→bus + apps/server test split). No MEDIUM justification.

## Per-file change list

### β — packages/db (inbox→bus wiring)

**Why:** The plan's spec says "inbox watcher pushes to bus on successful append, alongside the chokidar callback". Current code: `packages/db/src/inbox.ts:164-185` calls `sessions.appendEvent` and moves the file, but never publishes the inserted row. POST /events from the server does publish (events.ts:168), so the bus is wired for direct POST. The missing path is file-based inbox writes — those should also surface as events on the bus so external watchers (SSE consumers) see them.

- **NEW `packages/db/src/bus-noop.ts`**
  - Export `EventBusNoop: Layer<EventBus>` — `publish()` = `Effect.void`, `subscribe()` returns `{ queue: empty Queue, unsub: () => {} }`.
  - Exists so CLI / db-direct consumers don't need a real bus.
- **EDIT `packages/db/src/layers/live.ts`**
  - Add `EventBusNoop` to `DbLive`'s public output (union line ~150-159, add `EventBus` to the output Context tags).
  - Use `Layer.merge(DbLive, EventBusNoop)` OR add `EventBus` directly to DbLive's output. Picker picks the first (less invasive — DbLive stays focused on storage).
  - Verify existing db tests (`packages/db/test/**`) still pass — they may need `EventBus` added to the Layer they build. If so, provide them via `EventBusNoop`.
- **EDIT `packages/db/src/inbox.ts`**
  - In `makeInboxWatcher`, add `EventBus` to the Context requirements (yield* the tag).
  - After `yield* logger.log(...)` (line ~172), call `yield* eventBus.publish(result.event)` to push the inserted row.
  - Defensive: wrap in `Effect.ignoreLogged` so a bus error doesn't fail the file-move path. Bus failure is observable, not fatal.

**Risk:** `EventBusNoop` default works because every db consumer can supply it. Cost: ~10-20 db tests may need their Layer composition updated to include `EventBusNoop`. Mitigation: do the test sweep as part of β. If >5 test files need editing, fall back to "make `EventBus` optional in DbLive via `Layer.succeed` always" — i.e. always include EventBusNoop in the default output, no consumer can fail to satisfy it.

### δ — apps/server/test (split + 3 missing cases + constraint test cite)

**Why:** Existing `apps/server/test/server.test.ts` has 8 cases. Plan spec calls for 5 test files; current 1 file bundles them. Plus 3 cases are missing entirely: `redaction_applied` assertion, SSE live-delivery, bearer 401. Plus the constraint chokepoint is inherited from 3c (closed as Cognit-5vl.9) — needs to be cited.

- **NEW `apps/server/test/healthz.test.ts`** — extract /healthz cases (200 no-auth, envelope shape `{version, kind, data}`). 1-2 cases.
- **NEW `apps/server/test/sessions-routes.test.ts`** — extract /sessions list, /sessions/:id, /sessions/:id/state, /sessions/:id/events, 404 unknown id. ~5 cases.
- **NEW `apps/server/test/sse-bus.test.ts`** — SSE live-delivery test:
  - Boot server on ephemeral port (port 0, read port from server log or `server.address().port`).
  - GET /events/stream → start ReadableStream consumer.
  - POST /events with `observation_recorded` + unique text.
  - Assert consumer receives the event within 1s.
  - Second case: assert replay — POST 3 events, then GET /events/stream, assert all 3 received.
- **NEW `apps/server/test/post-events-redaction.test.ts`** — assert `redaction_applied` event fires:
  - POST /events with payload containing a PEM block (matches `BUILT_IN_REDACTION_PATTERNS.pem_block`).
  - Assert response 201.
  - GET /sessions/:id/events → assert BOTH the original event AND a subsequent `redaction_applied` event exist.
- **NEW `apps/server/test/auth-bearer.test.ts`** — assert 401 path:
  - Need a `makeAppWithAuth(apiToken, isLoopback)` helper variant (or build the Hono app in-test). The current `makeApp` in `server.test.ts` builds without bearer wiring. Add a sibling helper `makeAppWithAuth({apiToken, isLoopback})` to the test file (or to a new `apps/server/test/helpers.ts`).
  - Case 1: `apiToken: "secret"`, `isLoopback: false` → GET /sessions without `Authorization: Bearer secret` → 401; with header → 200.
  - Case 2: `apiToken: "secret"`, `isLoopback: true` → GET /sessions without header → 200 (loopback bypass).
- **EDIT `apps/server/test/server.test.ts`** — shrink to 1-2 integration smoke cases (or delete; the 4 split files cover everything in the plan's "split 1→5" requirement, plus the original server.test.ts content is preserved in `sessions-routes.test.ts` + `healthz.test.ts`).
  - **Decision: delete `server.test.ts`.** All 8 cases are covered by the 4 split files. Avoids duplication.
- **NEW `apps/server/test/helpers.ts`** (if makeApp needs to be shared) — `makeApp()`, `makeAppWithAuth({apiToken, isLoopback})`, ephemeral-port boot helper. The 5 test files import from here.
- **Constraint chokepoint coverage:** 3c (Cognit-5vl.9, closed) already tests `evalRules` directly in `packages/db/test/constraint-engine.test.ts` + `packages/db/test/constraint-policy.test.ts`. Server's `routes/events.ts:185-187` already maps `ConstraintViolation` → 422. **No additional server-side test required** — the 3c tests prove the chokepoint, the route proves the mapping. Cite this in the test plan doc.

**Risk:** SSE test port allocation. Use port 0 → OS-assigned → read from `server.address().port`. Don't hardcode 6971.

## Sequencing

**β and δ are independent** (different packages, zero file overlap). Run in 2 parallel worktrees:

- Worktree A: β (packages/db/**)
- Worktree B: δ (apps/server/test/**, apps/server/test/helpers.ts, delete apps/server/test/server.test.ts)

Merge to main in any order. No conflicts.

**Alternative (serial, no worktrees):** β first → run `pnpm --filter @cognit/db test` → δ → run `pnpm --filter @cognit/server test`. Slower wall-clock but no worktree overhead.

**Pick: parallel worktrees.** Each cluster's diff is <50 lines + 1-2 new files; merge risk is low. Worktrees give wall-clock savings for a SMALL task.

## New types / interfaces

```ts
// packages/db/src/bus-noop.ts (NEW)
export const EventBusNoop: Layer<EventBus, never, never> = Layer.succeed(
  EventBus,
  { publish: (_row) => Effect.void, subscribe: () => ({ queue: Queue.unbounded<EventRow>().unsafeRunSync(), unsub: () => {} }) }
);

// apps/server/test/helpers.ts (NEW)
export async function bootServer(opts: { port?: number; apiToken?: string; isLoopback?: boolean }): Promise<{ url: string; close: () => Promise<void> }>;
export function makeApp(): Hono;
export function makeAppWithAuth(opts: { apiToken: string; isLoopback: boolean }): Hono;
```

## Acceptance (mapped to phase-3.md done_when)

| Criterion | Status | Verified by |
|---|---|---|
| Hono boot on 127.0.0.1:6971 | ✓ already | existing flow |
| /healthz 200 no-auth | ✓ already | healthz.test.ts |
| /sessions list w/ envelope | ✓ already | sessions-routes.test.ts |
| /sessions/:id/state | ✓ already | sessions-routes.test.ts |
| /events/stream SSE replays last 50, then live | ✓ already + new | sse-bus.test.ts |
| POST /events through appendEvent | ✓ already | sessions-routes.test.ts (existing) |
| `redaction_applied` event fires | ✗ missing | post-events-redaction.test.ts (NEW) |
| Bearer 401 on non-loopback bind + token set | ✗ missing | auth-bearer.test.ts (NEW) |
| Bearer off on loopback bind | ✗ missing | auth-bearer.test.ts (NEW) |
| Inbox watcher publishes to bus | ✗ missing | sse-bus.test.ts (file-watcher scenario + bus assertion) |
| Constraint chokepoint through POST /events | ✓ covered by 3c | packages/db/test/constraint-engine.test.ts + routes/events.ts:185-187 |

All 4 done_when criteria from phase-3.md 3d section are covered by 3c tests + 3d existing + 3 NEW test cases.

## Risks (revised)

- **R1 (revised):** β's DbLive output union change may ripple to 10-20 db tests. Mitigation: β does the test sweep in-cluster; if >5 files break, add `EventBusNoop` to DbLive output as a default (not via Layer.merge) so no consumer can fail to satisfy it.
- **R2:** δ's `makeAppWithAuth` is a new helper — risk of divergence from production wiring. Mitigation: helper imports the same `auth.ts` middleware used by `index.ts` (single source of truth).

## Out of scope (deferred, per phase-3.md)

UI/dashboard on :6970 · MCP transport · snapshot file mirror · background snapshot sweeper · multi-actor RLS · webhooks · cognit doctor / gc · v0.1 release artifact · SessionStateView view-projection type (defer to first bead that extends SessionState with `applied_rule_ids`).
