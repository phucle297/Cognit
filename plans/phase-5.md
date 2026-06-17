# Phase 5 — Hono API Server (v0.1 MVP)

> Status: plan. Phase 4 (Cognit-oqd) closed 2026-06-17. Phase 5 = complete the
> API surface per `plan.xml §v0_1_phases §phase id="5"`. Phase 6 (dashboard) is
> a separate workstream that depends on this phase.
> Combined design + fix plan. Read top-to-bottom = build order.

## Done-when (from `plan.xml:775`)

> Dashboard can read Cognit state through HTTP

## Reality check (gap audit)

Phase 3 5vl.10 laid the foundation: Hono boot, `/healthz`, `/sessions*`, `/events*`
list/POST, `/events/stream` SSE replay+live, bearer auth, event bus, route
splits. **15 routes MISSING, 4 PARTIAL, 5 cross-cutting gaps** = **19 items**.

| Surface | Status |
|---|---|
| Read endpoints | 6/11 done. Missing: `/projects` (×2), filtered `/events?…`, `sessions/:id/{graph,recovery,edges}` (×3), `/actors` |
| Write endpoints | 1/9 done (POST /events). Missing: /projects, /sessions, sessions/:id/{pause,close,resume}, sessions/:id/edges, /verify, /verify/:id/cancel, /actors (×9) |
| Path alias | Plan says `/health`; code has `/healthz`. Reconcile by adding `/health` alias |
| SSE | Implemented (no `id:` field, no heartbeat, replay=50) |
| Auth | Bearer wired on /sessions/* + /events/*. Loopback bypass. Missing: /health exempt, /verify, /projects, /actors coverage. No `auth:` section in cognit.yaml. |
| CORS | `*` wildcard; allowlist deferred to v0.2 (explicit design decision) |
| Error envelope | Mixed: success = `{version,kind,data}`; errors = `{error,message,cause}` (no version/kind) |
| Event bus | `EventBusLive` in apps/server, noop in db. Inbox watcher publishes. Queue unbounded. No shutdown. |
| SSE heartbeat | None |
| SSE replay cursor | Header ignored; default 50 |
| Server build | `echo "no build yet (Phase 5)"` |

## Gap → subtask coverage (the answer to "does 5.1-5.8 cover all 19?")

**Yes, with one fix:** `/health` alias added to **5.3** (was missing). CORS allowlist
explicitly deferred to v0.2 (design decision, not a v0.1 gap).

| # | Gap | Status | Fixed by |
|---|---|---|---|
| 1 | `GET /health` missing (path mismatch) | MISSING | **5.3.8** (new — see below) |
| 2 | `GET /projects` | MISSING | 5.4.1 |
| 3 | `POST /projects` | MISSING | 5.4.1 |
| 4 | `POST /sessions` | MISSING | 5.4.2 |
| 5 | `POST /sessions/:id/pause` | MISSING | 5.4.2 |
| 6 | `POST /sessions/:id/close` | MISSING | 5.4.2 |
| 7 | `POST /sessions/:id/resume` | MISSING | 5.4.2 |
| 8 | `GET /sessions/:id/graph` | MISSING | 5.5.1 |
| 9 | `GET /sessions/:id/recovery` | MISSING | 5.5.2 |
| 10 | `GET /sessions/:id/edges` | MISSING | 5.5.3 |
| 11 | `POST /sessions/:id/edges` | MISSING | 5.5.3 |
| 12 | `POST /verify` | MISSING | 5.6.1 |
| 13 | `POST /verify/:id/cancel` | MISSING | 5.6.1 |
| 14 | `GET /actors` | MISSING | 5.6.2 |
| 15 | `POST /actors` | MISSING | 5.6.2 |
| 16 | `GET /events?…` filter params | PARTIAL | 5.7.1 |
| 17 | Bearer auth on /verify /projects /actors + /health exempt | PARTIAL | 5.3.1, 5.3.3, 5.3.4 |
| 18 | Error envelope (4xx/5xx) inconsistency | PARTIAL | 5.7.2 |
| 19 | SSE live-mode reliability (id field, replay cursor, heartbeat, shutdown) | PARTIAL | 5.2.1-5.2.6 |

**CORS allowlist:** v0.2 (deferred by design in §CORS). Not a v0.1 fix.

## Integration order

1. **C — Event bus chokepoint** (5.1) first. Bus is the seam. Consolidate
   `publish` into `SessionService.appendEvent`. Move `EventBusLive` into
   `packages/db`. Swap unbounded → bounded queue, per-subscriber 100ms
   timeout, add `shutdown` to the Tag.
2. **B — SSE live mode** (5.2) second. Add `id:` field, `Last-Event-ID`
   replay path, raise default to 1000, heartbeat ticker, `bus.shutdown` →
   controller.close, `retry: 5000`.
3. **A — Bearer auth** (5.3) + **5.3.8 /health alias** in parallel with
   5.2. Add `auth:` section, precedence env > CLI > yaml, exempt
   `/health`, cookie-based dashboard login, same-origin static serving.
4. Route surface (5.4-5.7). Independent of A/B/C, but publishes use
   consolidated bus (1) and route mounts go behind auth middleware (3).
5. E2E + results doc + test count audit (5.8).

## Subtasks (bd epic + children)

| ID | Title | P | Type | Files | Tests |
|---|---|---|---|---|---|
| 5.1 (w61.9) | Event bus chokepoint | P1 | chore | `packages/db/src/bus-live.ts` (NEW), `bus-noop.ts` (NEW), `layers/live.ts`, `inbox.ts`, `session-service.ts`; `apps/server/src/bus.ts` | `packages/db/test/bus.test.ts` (NEW, 4-6) |
| 5.2 (w61.2) | SSE live mode | P1 | feature | `apps/server/src/sse.ts`, `event-queries.ts`, `routes/events.ts` | `apps/server/test/sse-bus.test.ts` (+3) |
| 5.3 (w61.3) | Bearer auth + /health alias + dashboard origin | P1 | feature | `apps/server/src/auth.ts`, `index.ts`, `config.ts` (NEW), `routes/auth.ts` (NEW); `packages/cli/src/commands/server.ts` (NEW) | `apps/server/test/auth-bearer.test.ts` (+2) |
| 5.4 (w61.4) | Project + session lifecycle routes | P1 | feature | `apps/server/src/routes/projects.ts` (NEW), `routes/sessions.ts` (extend) | `projects-routes.test.ts` (NEW, 5), `session-mutations.test.ts` (NEW, 6) |
| 5.5 (w61.5) | State + graph + recovery + edges routes | P1 | feature | `apps/server/src/routes/sessions.ts` (extend), `routes/edges.ts` (NEW) | `state-graph-edges.test.ts` (NEW, 8) |
| 5.6 (w61.6) | Verify + actors routes | P1 | feature | `apps/server/src/routes/verify.ts` (NEW), `routes/actors.ts` (NEW) | `verify-routes.test.ts` (NEW, 5), `actors-routes.test.ts` (NEW, 4) |
| 5.7 (w61.7) | Filtered `/events` + error envelope | P1 | feature | `apps/server/src/routes/events.ts`, `envelope.ts`, `api-error.ts` (NEW) | `events-filtered.test.ts` (NEW, 5), `envelope.test.ts` (NEW, 3) |
| 5.8 (w61.8) | E2E + cleanup + results doc + test count audit | P2 | chore | `apps/server/test/phase-5.e2e.test.ts` (NEW), `docs/phase-5-results.md` (NEW), `apps/server/package.json` | 1 E2E (13 assertions) |

**8 subtasks. 5.1 must land first (chokepoint). 5.2 + 5.3 in either order
next. 5.4-5.7 are 4 parallel workstreams touching disjoint route files.
5.8 last.**

## API contract decisions

- `since` on `GET /events` is an event **id** (ULID), not a timestamp.
- `POST /sessions/:id/resume` is **split out** from `POST /sessions`.
- Edges validated against §edge_types catalog at API boundary (400 on unknown).
- Implicit `verified_by` edges **synthesized in `GET /sessions/:id/graph`**, not stored.
- `POST /verify` returns 201 **immediately** with `state: "started"`; lifecycle updates via SSE.
- Cancel is **idempotent and returns 200**, not 409.
- Success envelope unchanged. Error envelope gains `kind: "api_error"`, `code`, `request_id`.
- Cursor pagination only (no offset). `next_cursor: null` = exhausted.
- ISO 8601 with trailing `Z` everywhere.
- Idempotency: `POST /events` (id in body), `POST /sessions/:id/edges` (`client_edge_id`), `POST /verify/:id/cancel` (terminal = no-op).

## Cross-cutting decisions

### Event bus

| Decision | Choice | Why |
|---|---|---|
| Trigger | Single chokepoint in `SessionService.appendEvent` | One publish, all callers |
| Queue model | `Queue.bounded(10_000, "dropping")` per subscriber | Unbounded OOMs; bounded forces explicit failure |
| Failure mode | Per-subscriber 100ms timeout, `Effect.ignoreLogged` | Bus is observability, not system of record |
| Shutdown | `EventBus.shutdown()` → queue sentinel → controller.close | Clean SSE close on SIGTERM |
| Location | `EventBusLive` moves to `packages/db/src/bus-live.ts`; apps/server re-exports | Inbox watcher needs the real bus |

### SSE

| Decision | Choice | Why |
|---|---|---|
| Replay | Honor `Last-Event-ID`; default 1000 (was 50) | Crash-resilient reconnect |
| Live | `EventBus.subscribe` → `Queue.take` in forked drain fiber | Existing shape, correct |
| Frame `id:` | Required, every frame | Browser sends back as `Last-Event-ID` |
| Heartbeat | `: ping\n\n` every 15s | Proxy keep-alive |
| Backpressure | Bounded queue + drop-oldest + synthetic `stream_overflow_dropped` | Never close a slow consumer |
| Filter | None on `/events/stream` (always project-wide) | Filtering is client-side; v0.1 static `/events?…` is the filtered read |
| Retry hint | `retry: 5000` on connect | Give restarted server time to come back |
| Effect primitive | `Queue.take` in `Effect.forkDaemon`, **not** `Stream.async` | Bridge to Hono's `ReadableStream` body |

### Auth

| Decision | Choice | Why |
|---|---|---|
| Token source | env `COGNIT_API_TOKEN` > CLI `--api-token` > `auth.api_token` | Env escapes a leaked yaml |
| Storage | Memory-only, plaintext, loaded once at boot | Local-first; threat model is "rogue local user" |
| Loopback bypass | `127.0.0.1`, `::1`, UDS always bypass | OS-isolated loopback is the boundary |
| Exception | `GET /health` always 200, no auth | Probes must not need a token |
| 401 vs 403 | 401 only (wrong/missing token); 403 = post-v0.2 RLS | Single failure mode for v0.1 |
| Dashboard origin | **API serves dashboard on same port (6971)**. Cookie-based auth. | `EventSource` cannot carry `Authorization`; same-origin resolves it. Implies phase 6 dashboard served by the API server, not a separate `:6970`. |
| Cookie | `HttpOnly`, `SameSite=Strict`, `Secure` when non-loopback | Standard local-first UX |
| Rotation | Restart only | Single-tenant, restart is cheap |

### CORS

| Decision | Choice | Why |
|---|---|---|
| v0.1 | Keep `*`. Defer allowlist to v0.2. | Out of phase 5 scope; current behaviour is safe for local use |

---

## Build order

```
0.  Confirm dashboard origin (:6971 same-origin)                       [BLOCKER for 5.3]
1.  5.1  Event bus chokepoint                                          [chokepoint, gates 5.2]
2.  5.2  SSE live mode                                                 [parallel with 5.3]
3.  5.3  Bearer auth + /health alias + dashboard cookie                [parallel with 5.2]
4.  5.4  Project + session lifecycle routes                            [parallel with 5.5/5.6/5.7]
5.  5.5  State + graph + recovery + edges routes                       [parallel with 5.4/5.6/5.7]
6.  5.6  Verify + actors routes                                        [parallel with 5.4/5.5/5.7]
7.  5.7  Filtered /events + error envelope                             [parallel with 5.4/5.5/5.6]
8.  5.8  E2E + docs + test count audit                                 [last]
```

Steps 2-7 are 6 disjoint workstreams; run in 6 worktrees.

---

## 5.1 — Event bus chokepoint

**Files:**
- NEW `packages/db/src/bus-live.ts` (move from `apps/server/src/bus.ts`)
- NEW `packages/db/src/bus-noop.ts`
- EDIT `packages/db/src/layers/live.ts`
- EDIT `packages/db/src/inbox.ts`
- EDIT `packages/db/src/session-service.ts`
- EDIT `apps/server/src/bus.ts` (re-export only)
- NEW `packages/db/test/bus.test.ts`

### 5.1.1 — Move `EventBusLive` into `packages/db`

**Current:** `apps/server/src/bus.ts:1-54` (in-process `Ref<Queue[]>` shape).

**Move to** `packages/db/src/bus-live.ts` with same shape, but:
- Queue: `Queue.bounded(10_000)` with custom drop-oldest strategy.
- Add `shutdown: Effect<void>` to `EventBusShape`.
- `publish` adds per-subscriber `Effect.timeout(100ms)`.

**Shape:**
```ts
// packages/db/src/bus-live.ts
export const EventBusLive: Layer<EventBus, never, never> =
  Layer.effect(
    EventBus,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<SubscriberHandle>>([]);
      return {
        publish: (row) => Effect.gen(function* () {
          const subs = yield* Ref.get(ref);
          yield* Effect.forEach(
            subs,
            (s) => s.queue.offer(row).pipe(Effect.timeout("100 millis"), Effect.ignoreLogged),
            { discard: true }
          );
        }),
        subscribe: Effect.gen(function* () {
          const q = yield* Queue.bounded<EventRow | symbol>(10_000, { strategy: "dropping" });
          const handle: SubscriberHandle = { queue: q, unsub: ... };
          yield* Ref.update(ref, (xs) => [...xs, handle]);
          return { queue: q, unsub: ... };
        }),
        shutdown: Ref.get(ref).pipe(Effect.flatMap((subs) =>
          Effect.forEach(subs, (s) => Queue.shutdown(s.queue), { discard: true })
        )),
      };
    })
  );
```

### 5.1.2 — `EventBusNoop` default

**NEW** `packages/db/src/bus-noop.ts`:
```ts
export const EventBusNoop: Layer<EventBus, never, never> = Layer.succeed(
  EventBus,
  {
    publish: (_row) => Effect.void,
    subscribe: Effect.succeed({ queue: Queue.unbounded<EventRow | symbol>().unsafeRunSync(), unsub: Effect.void }),
    shutdown: Effect.void,
  }
);
```

### 5.1.3 — `DbLive` includes `EventBusNoop` by default

**EDIT** `packages/db/src/layers/live.ts:150-159` — change the public output
type from `DbLive` to `Layer<DbLiveContext, never, never>` to include
`EventBus` via `EventBusNoop`. The server overrides with `EventBusLive` at
the app boundary.

### 5.1.4 — Consolidate publish in `SessionService.appendEvent`

**EDIT** `packages/db/src/session-service.ts` — find `appendEvent` and append:
```ts
yield* eventBus.publish(row).pipe(Effect.ignoreLogged);  // best-effort
```

**Remove duplicates:**
- `apps/server/src/routes/events.ts:168` — delete local publish call.
- `packages/db/src/inbox.ts:189` — delete `eventBus.publish(result.event)` (now done by service).

### 5.1.5 — Re-export from `apps/server/src/bus.ts`

**EDIT** `apps/server/src/bus.ts`:
```ts
export { EventBusLive } from "@cognit/db/bus-live";
export type { SubscriberHandle } from "@cognit/db/bus-live";
```

### 5.1.6 — Tests

**NEW** `packages/db/test/bus.test.ts` (4-6 cases):
1. `publish` delivers to all subscribers.
2. `publish` to dropped-subscriber queue is non-blocking (timeout fires).
3. `shutdown` causes `Queue.take` to reject.
4. Subscriber unsubscribed is removed from `Ref`.
5. Slow subscriber (never reads) does not block publisher.
6. `EventBusNoop.publish` is a no-op (regression guard).

**Smoke:** `pnpm --filter @cognit/db test` green.

---

## 5.2 — SSE live mode

**Files:**
- EDIT `apps/server/src/sse.ts`
- EDIT `apps/server/src/event-queries.ts`
- EDIT `apps/server/src/routes/events.ts`
- EDIT `apps/server/test/sse-bus.test.ts` (+3 cases)

### 5.2.1 — `id:` field on every frame

**EDIT** `apps/server/src/sse.ts:46-58`. Current:
```ts
controller.enqueue(`event: event\ndata: ${JSON.stringify(row)}\n\n`);
```

**New:**
```ts
controller.enqueue(
  `id: ${row.id}\nevent: event\ndata: ${JSON.stringify(row)}\n\n`
);
```

### 5.2.2 — Honor `Last-Event-ID` header

**EDIT** `apps/server/src/sse.ts:38-58`:
```ts
const lastEventId = c.req.header("last-event-id");
const replayCursor = lastEventId ?? null;
```

**NEW** `apps/server/src/event-queries.ts`:
```ts
export const listAfterEventAcrossProjectE = (
  projectId: string,
  afterId: string,
  limit: number
): Effect.Effect<ReadonlyArray<EventRow>, DbError> => ...;
```

Handler uses cursor-aware replay if `lastEventId` set, else last-N=1000.

### 5.2.3 — Default replay 50 → 1000

**EDIT** `apps/server/src/sse.ts:39` — change `replayLimit` default.

### 5.2.4 — Heartbeat every 15s

**EDIT** `apps/server/src/sse.ts:60-100` — add ticker fiber:
```ts
const heartbeat = Effect.gen(function* () {
  while (true) {
    yield* Effect.sleep("15 seconds");
    yield* Effect.try(() => controller.enqueue(`: ping\n\n`)).pipe(Effect.ignoreLogged);
  }
}).pipe(Effect.forkDaemon);
```

Add `heartbeat` to `cleanup` `Effect.all([...])`.

### 5.2.5 — `bus.shutdown` on SIGTERM

**EDIT** `apps/server/src/sse.ts:cleanup` — add `yield* eventBus.shutdown().pipe(Effect.ignoreLogged)`. (Server-wide shutdown wired at `apps/server/src/index.ts:140` via top-level `Effect.onInterrupt`.)

### 5.2.6 — `retry: 5000` on connect

**EDIT** `apps/server/src/sse.ts:38-40` — first frame after headers:
```ts
controller.enqueue(`retry: 5000\n`);
```

### 5.2.7 — Tests

**EDIT** `apps/server/test/sse-bus.test.ts` (+3 cases):
1. **id-field roundtrip:** POST event, GET stream, parse frame, assert `id: <row.id>` in raw text.
2. **Last-Event-ID replay:** POST 3 events, GET stream with `Last-Event-ID: <id-1>`, assert only events 2+3.
3. **Heartbeat:** open stream, advance fake timers 16s, assert `: ping` in raw text.

---

## 5.3 — Bearer auth + /health alias + dashboard origin

> **BLOCKER:** confirm with user that dashboard is served by API server on :6971
> (not :6970 standalone). Phase 6 plan depends on this.

**Files:**
- EDIT `apps/server/src/auth.ts`
- EDIT `apps/server/src/index.ts`
- NEW `apps/server/src/config.ts`
- NEW `apps/server/src/routes/auth.ts`
- NEW `packages/cli/src/commands/server.ts`
- EDIT `apps/server/test/auth-bearer.test.ts` (+2 cases)

### 5.3.1 — `auth:` section in cognit.yaml

**NEW** `apps/server/src/config.ts`:
```ts
export interface AuthConfig {
  readonly apiToken: string | null;     // from env / CLI / yaml
  readonly bind: "127.0.0.1" | "0.0.0.0" | "::1";
  readonly cookieName: string;          // default "cognit_session"
}
```

Resolution: env `COGNIT_API_TOKEN` > CLI `--api-token` > yaml `auth.api_token`.
`bind` defaults to `127.0.0.1` (forces loopback bypass).

### 5.3.2 — `/auth/login` route

**NEW** `apps/server/src/routes/auth.ts`:
- `GET /auth/login` — serves a small HTML form.
- `POST /auth/login` — body `{ token: string }`. If matches `cfg.apiToken`,
  set cookie `cognit_session=<token>` with `HttpOnly`, `SameSite=Strict`,
  `Secure` (when non-loopback), `Path=/`, `Max-Age=86400`. Return 204.

### 5.3.3 — Exempt `/health` from bearer

**EDIT** `apps/server/src/auth.ts:33-46` — middleware skips when `c.req.path === "/health"`. Test in 5.3.7.

### 5.3.4 — Mount order

**EDIT** `apps/server/src/index.ts:140-143`:
```ts
app.use("*", async (c, next) => {       // loopback bypass
  if (!shouldEnforceAuth(cfg)) return next();
  if (c.req.path === "/health") return next();
  if (c.req.path === "/auth/login") return next();
  return requireBearer(cfg)(c, next);
});
```

### 5.3.5 — Same-origin dashboard (API serves static)

**EDIT** `apps/server/src/index.ts` — at end of `app.route(...)`:
```ts
app.get("*", serveStatic({ root: "./apps/dashboard/dist" }));
```

(`import { serveStatic } from "@hono/node-server/serve-static"` if not present.)

### 5.3.6 — `cognit server` CLI

**NEW** `packages/cli/src/commands/server.ts` — `cognit server [--port 6971] [--api-token X] [--no-foreground]`. Boots Hono.

### 5.3.7 — Tests

**EDIT** `apps/server/test/auth-bearer.test.ts` (+2 cases):
1. **/health exempt:** `apiToken` set + `isLoopback=false`, GET `/health` returns 200 without bearer.
2. **Cookie login:** POST `/auth/login` with correct token sets `Set-Cookie: cognit_session=...; HttpOnly; SameSite=Strict`. Wrong token → 401.

### 5.3.8 — `/health` alias (closes gap #1)

**EDIT** `apps/server/src/routes/healthz.ts` — export the handler, then in
`apps/server/src/index.ts` mount it twice:
```ts
import { healthzHandler } from "./routes/healthz";
app.get("/healthz", healthzHandler);
app.get("/health",  healthzHandler);  // plan.xml §api line 437 alias
```

Test in `apps/server/test/healthz.test.ts` — add case:
- `GET /health` returns the same envelope shape as `/healthz`.

---

## 5.4 — Project + session lifecycle routes

**Files:**
- NEW `apps/server/src/routes/projects.ts`
- EDIT `apps/server/src/routes/sessions.ts`
- NEW `apps/server/test/projects-routes.test.ts` (5 cases)
- NEW `apps/server/test/session-mutations.test.ts` (6 cases)

### 5.4.1 — `GET /projects`, `POST /projects`

**NEW** `apps/server/src/routes/projects.ts`:
```ts
export const projectsRoute = new Hono()
  .get("/projects", (c) => /* list from DbLive */)
  .post("/projects", (c) => /* validate body, INSERT, append project_created */);
```

**Body schema (Effect Schema):**
```ts
const PostProjectsBody = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120), Schema.pattern(/^[a-z0-9][a-z0-9._-]*$/i)),
  repo_url: Schema.optional(Schema.String.pipe(Schema.pattern(/^https?:\/\//))),
});
```

**Errors:** `400 validation_failed` (name/repo_url), `409 conflict` (UNIQUE name).

**Mount** in `apps/server/src/index.ts`:
```ts
app.route("/", projectsRoute);
```

### 5.4.2 — `POST /sessions`, `POST /sessions/:id/{pause,close,resume}`

**EDIT** `apps/server/src/routes/sessions.ts` — append:
```ts
.post("/sessions", (c) => /* validate {goal, parent_session_id?, fork_on_resume?}, INSERT, append session_created */)
.post("/sessions/:id/pause", (c) => /* load session, check status, append session_paused, update status=paused */)
.post("/sessions/:id/close",  (c) => /* check not closed, append session_closed, update status=closed, closed_at=now, trigger snapshot */)
.post("/sessions/:id/resume", (c) => {
   /* if config.session.fork_on_resume (default true) AND parent is paused:
        create new session with parent_session_id, append session_created
      else:
        update parent status=active, append session_resumed */
});
```

**Errors:** `404 not_found`, `409 conflict` (illegal transition), `400 validation_failed`.

### 5.4.3 — Tests

**NEW** `apps/server/test/projects-routes.test.ts` (5 cases):
1. `GET /projects` returns empty list initially.
2. `POST /projects` with valid body returns 201 + `kind: "project.created"`.
3. `POST /projects` with missing name returns 400.
4. `POST /projects` with empty name returns 400.
5. `POST /projects` then `GET /projects` lists the new project.

**NEW** `apps/server/test/session-mutations.test.ts` (6 cases):
1. `POST /sessions` with goal creates 201 + session row.
2. `POST /sessions/:id/pause` on active → status=paused.
3. `POST /sessions/:id/close` on paused → status=closed, snapshot triggered.
4. `POST /sessions/:id/resume` (default fork) → new session with `parent_session_id`.
5. `POST /sessions/:id/pause` on closed returns 409.
6. `POST /sessions/:id/pause` on unknown id returns 404.

---

## 5.5 — State + graph + recovery + edges routes

**Files:**
- EDIT `apps/server/src/routes/sessions.ts`
- NEW `apps/server/src/routes/edges.ts`
- NEW `apps/server/test/state-graph-edges.test.ts` (8 cases)

### 5.5.1 — `GET /sessions/:id/graph`

**EDIT** `apps/server/src/routes/sessions.ts` — append:
```ts
.get("/sessions/:id/graph", (c) => {
   /* query hypotheses, decisions, conclusions, verifications, findings for session
      build GraphNode[] with id = `${entity_type}:${entity_id}`
      query edges table, build GraphEdge[]
      synthesize implicit verified_by for conclusion+verification pairs
      return envelope */
});
```

**Implicit verified_by synthesis:** for each `conclusion_verified` event
in the session, if a `verified_by` edge does not already exist, synthesize
a virtual edge (not persisted; just in the response).

### 5.5.2 — `GET /sessions/:id/recovery` (v0.1, 3 fields only)

**EDIT** `apps/server/src/routes/sessions.ts`:
```ts
.get("/sessions/:id/recovery", (c) => {
   /* query hypothesis_rejected, decision_accepted, conclusion_verified events
      build RejectedHypothesis[], AcceptedDecision[], VerifiedConclusion[]
      do NOT include related_sessions, suggested_next_steps (v0.2) */
});
```

**Test guard:** explicitly assert response has no `related_sessions` or `suggested_next_steps` keys.

### 5.5.3 — `GET /sessions/:id/edges` + `POST /sessions/:id/edges`

**NEW** `apps/server/src/routes/edges.ts`:
```ts
const EDGE_CATALOG = {
  tests:        { from: ["experiment"],   to: ["hypothesis"] },
  supports:     { from: ["finding","conclusion"], to: ["hypothesis"] },
  contradicts:  { from: ["finding","conclusion"], to: ["hypothesis"] },
  supersedes:   { from: ["hypothesis","decision"], to: ["hypothesis","decision"] },
  caused:       { from: ["decision"],     to: ["experiment"] },
  based_on:     { from: ["decision"],     to: ["conclusion"] },
  verified_by:  { from: ["conclusion"],   to: ["verification"] },
  belongs_to:   { from: ["hypothesis"],   to: ["theory"] },
  derived_from: { from: ["finding"],      to: ["observation","finding"] },
  references:   { from: ["any"],          to: ["artifact"] },
} as const;

export const edgesRoute = new Hono()
  .get("/sessions/:id/edges", (c) => /* filter edge_type/from/to/limit/cursor */)
  .post("/sessions/:id/edges", (c) => {
     /* validate edge_type in catalog, from/to types match row above
        400 if not
        idempotency: if client_edge_id present, return existing row on dup
        INSERT, append edge_created, publish to bus */
  });
```

**Mount** in `apps/server/src/index.ts`.

### 5.5.4 — Tests

**NEW** `apps/server/test/state-graph-edges.test.ts` (8 cases):
1. `GET /sessions/:id/state` returns kind `session.state`.
2. `GET /sessions/:id/state` on unknown id returns 404.
3. `GET /sessions/:id/graph` returns nodes (deduped) + edges.
4. `GET /sessions/:id/recovery` returns exactly 3 fields, no `related_sessions` / `suggested_next_steps`.
5. `GET /sessions/:id/recovery` on empty session returns empty arrays.
6. `GET /sessions/:id/edges` returns typed edges.
7. `POST /sessions/:id/edges` with valid catalog type emits `edge_created`.
8. `POST /sessions/:id/edges` with unknown `edge_type` returns 400.

---

## 5.6 — Verify + actors routes

**Files:**
- NEW `apps/server/src/routes/verify.ts`
- NEW `apps/server/src/routes/actors.ts`
- NEW `apps/server/test/verify-routes.test.ts` (5 cases)
- NEW `apps/server/test/actors-routes.test.ts` (4 cases)

### 5.6.1 — `POST /verify`, `POST /verify/:id/cancel`

**NEW** `apps/server/src/routes/verify.ts`:
```ts
const PostVerifyBody = Schema.Struct({
  command: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("lint","typecheck","test","build","benchmark","custom"),
  timeout_ms: Schema.optional(Schema.Number.pipe(Schema.between(1, 86_400_000))),
  linked_hypothesis_id: Schema.optional(Schema.String),
  correlation_id: Schema.optional(Schema.String),
});

export const verifyRoute = new Hono()
  .post("/verify", (c) => {
     /* validate body
        INSERT verifications row (state='started')
        append verification_started event (publishes via chokepoint)
        fork: spawnVerification from packages/verification
        lifecycle updates: passed/failed/errored/cancelled flow through appendEvent (not this route)
        return 201 with kind 'verification.started' and the row */
  })
  .post("/verify/:id/cancel", (c) => {
     /* lookup verification, signal running process
        if already terminal: return 200 with current state (idempotent)
        else: append verification_cancelled, update row state='cancelled', ended_at=now */
  });
```

**Wire verification package into apps/server Effect runtime:** in
`apps/server/src/index.ts` boot, add `Layer.merge(verifyLayer)` (or
whatever the verification package exports).

### 5.6.2 — `GET /actors`, `POST /actors`

**NEW** `apps/server/src/routes/actors.ts`:
```ts
const PostActorBody = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  type: Schema.Literal("human","worker","system"),
  trust_score: Schema.optional(Schema.Number.pipe(Schema.between(0, 1))),
});

export const actorsRoute = new Hono()
  .get("/actors", (c) => /* filter type/name_contains/cursor/limit */)
  .post("/actors", (c) => {
     /* validate body
        resolve trust_score: body > cognit.yaml actors.defaults[type] > 0.5
        INSERT actors row
        append actor_registered event
        return 201 */
  });
```

### 5.6.3 — Tests

**NEW** `apps/server/test/verify-routes.test.ts` (5 cases):
1. `POST /verify` starts (201, state='started').
2. `linked_hypothesis_id` stored on row.
3. `POST /verify/:id/cancel` transitions to `cancelled`, appends event.
4. `POST /verify/:id/cancel` on unknown id returns 404.
5. `POST /verify` on closed session returns 409.

**NEW** `apps/server/test/actors-routes.test.ts` (4 cases):
1. `GET /actors` lists (empty initially, includes auto-registered from POST /events).
2. `POST /actors` with valid body returns 201 + emits `actor_registered`.
3. `POST /actors` with invalid type returns 400.
4. `POST /actors` with duplicate name returns 409.

---

## 5.7 — Filtered `/events` + error envelope

**Files:**
- EDIT `apps/server/src/routes/events.ts`
- EDIT `apps/server/src/envelope.ts` (doc only)
- NEW `apps/server/src/api-error.ts`
- NEW `apps/server/test/events-filtered.test.ts` (5 cases)
- NEW `apps/server/test/envelope.test.ts` (3 cases)

### 5.7.1 — Filtered `GET /events`

**EDIT** `apps/server/src/routes/events.ts:121` — replace `/events/feed` (or add `/events`):
```ts
.get("/events", (c) => {
   const session = c.req.query("session");
   const type = c.req.queries("type");          // string[] | undefined
   const actor = c.req.query("actor");
   const since = c.req.query("since");          // ULID
   const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
   /* validate: since is ULID (26 chars Crockford), type known if strict (default true)
      build SQL with WHERE clauses
      ORDER BY id ASC
      LIMIT N+1 to detect next page
      return { events, next_cursor: events.length > N ? events[N-1].id : null } */
});
```

### 5.7.2 — New `ApiError` envelope

**NEW** `apps/server/src/api-error.ts`:
```ts
import { Schema } from "effect";

export const ApiErrorCode = Schema.Literal(
  "bad_request", "validation_failed", "unknown_event_type",
  "not_found", "session_unavailable", "constraint_violation",
  "conflict", "rate_limited", "internal"
);
export type ApiErrorCode = Schema.Schema.Type<typeof ApiErrorCode>;

export const ApiError = Schema.Struct({
  kind: Schema.Literal("api_error"),
  code: ApiErrorCode,
  message: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  request_id: Schema.String,
});
export type ApiError = Schema.Schema.Type<typeof ApiError>;

export const apiError = (c: ApiErrorCode, msg: string, details?: Record<string, unknown>, requestId: string) => ({
  kind: "api_error" as const,
  code: c, message: msg, ...(details && { details }), request_id: requestId,
});
```

**Helper Hono middleware** (`apps/server/src/api-error.ts`):
```ts
export const errorHandler = (handler: Effect.fnUntraced) => async (c) => {
  return Effect.runPromise(
    handler(c).pipe(
      Effect.catchAll((e) => Effect.succeed(c.json(apiError(mapErr(e), e.message, e.details, c.get("requestId")), mapStatus(e))))
    )
  );
};
```

**Replace ad-hoc 4xx/5xx** in:
- `apps/server/src/routes/events.ts:185-187` (constraint → 422)
- `apps/server/src/routes/sessions.ts` (404, 409)
- All new routes (5.4, 5.5, 5.6).

**EDIT** `apps/server/src/envelope.ts` — add doc comment:
```ts
// Success envelope: { version: 1, kind: <string>, data: <T> }
// Error envelope: see ./api-error.ts → ApiError (kind: "api_error")
```

### 5.7.3 — Tests

**NEW** `apps/server/test/events-filtered.test.ts` (5 cases):
1. `?session=<id>&limit=N` returns most recent N for session.
2. `?type=hypothesis_proposed` filters to that type.
3. `?actor=alice` filters by actor name.
4. `?since=<ulid>` excludes events with id ≤ since.
5. Combined `?session=&type=&actor=&since=&limit=` intersects all clauses.

**NEW** `apps/server/test/envelope.test.ts` (3 cases):
1. Success response has `{ version: 1, kind, data }` (no `request_id` required).
2. 4xx response has `{ kind: "api_error", code, message, request_id }`.
3. Error response does not include raw `cause` (sanitized).

---

## 5.8 — E2E + cleanup + results doc + test count audit

**Files:**
- NEW `apps/server/test/phase-5.e2e.test.ts` (1 E2E, 13 assertions)
- EDIT `apps/server/package.json` (real build)
- NEW `docs/phase-5-results.md`

### 5.8.1 — E2E flow

**NEW** `apps/server/test/phase-5.e2e.test.ts` — 13 assertions:
1. `bootServer({port: 0})` resolves; `server.url` is `http://127.0.0.1:<port>`.
2. `POST /events` (observation) returns 201, `kind: "event.appended"`.
3. `GET /sessions/:id/events` contains the observation.
4. `GET /sessions/:id/state` returns `kind: "session.state"`, includes goal.
5. `GET /events/stream` returns 200, `content-type: text/event-stream`.
6. SSE receives `hypothesis_proposed` frame within 1000ms (use `readUntil`).
7. `POST /verify` returns 201, `kind: "verification.started"`, `linked_hypothesis_id` set.
8. `GET /sessions/:id/state` shows verification entry.
9. `POST /verify/:id/cancel` returns 200, `kind: "verification.cancelled"`.
10. `GET /sessions/:id/state` shows `state: cancelled`.
11. **Auth branch** (separate boot): non-loopback + token set, no bearer → 401.
12. **Auth branch:** same setup, with `Authorization: Bearer <token>` → 200.
13. `GET /health` always 200 (auth on or off) — **also asserts /healthz same shape.**

**Helper reuse:** `bootServer`, `makeAppWithAuth`, `readUntil`, `parseSseFrames` from `helpers.ts` (extract `readUntil`/`parseSseFrames` from `sse-bus.test.ts:20-69` if not yet shared).

### 5.8.2 — Real build script

**EDIT** `apps/server/package.json:6`:
```json
"build": "tsup src/index.ts --format esm --target node24 --clean --dts"
```

(Add `tsup` devDep if not present.)

### 5.8.3 — Results doc

**NEW** `docs/phase-5-results.md` — sections:
- **Test count delta** (table: phase 4 → 5).
- **New files** (list with one-line description).
- **Bug fixes shipped** (per pattern in `docs/phase-4-results.md`).
- **AC closure** (link to Cognit-w61 AC; tick or cross).
- **Out of phase 5** (deferred items: phase 6 dashboard, v0.2 fields, RLS, webhooks).
- **Risks tracked but not exercised** (Windows, signal handling, etc.).

### 5.8.4 — Final gate

```bash
npx turbo run test --force   # green across all 8 new test files
npx turbo run typecheck      # green
npx turbo run lint           # green
```

Test count: project total ≥ 470 cases / 56 files.

---

## File ownership matrix (for parallel worktrees)

| Worktree | Touches | No-touch contract |
|---|---|---|
| 5.1 | `packages/db/src/{bus-live,bus-noop,layers/live,session-service,inbox}.ts`, `apps/server/src/bus.ts`, `packages/db/test/bus.test.ts` (NEW) | No edits to `apps/server/src/routes/*` or `event-queries.ts` |
| 5.2 | `apps/server/src/{sse,event-queries,routes/events}.ts`, `apps/server/test/sse-bus.test.ts` | No edits to `auth.ts` or new routes |
| 5.3 | `apps/server/src/{auth,index,config,routes/auth}.ts`, `packages/cli/src/commands/server.ts` (NEW), `apps/server/test/auth-bearer.test.ts` | No edits to route files (except /health alias) |
| 5.4 | `apps/server/src/routes/{projects,sessions}.ts`, 2 NEW test files | No edits to `sse.ts` or `envelope.ts` |
| 5.5 | `apps/server/src/routes/{sessions,edges}.ts`, NEW test file | No edits to other routes |
| 5.6 | `apps/server/src/routes/{verify,actors}.ts`, 2 NEW test files, `apps/server/src/index.ts` (only to add layer merge for verification) | No edits to other routes |
| 5.7 | `apps/server/src/{routes/events,envelope,api-error}.ts`, 2 NEW test files | No edits to other route files |
| 5.8 | NEW e2e file, `apps/server/package.json`, `docs/phase-5-results.md` | Reads only; no production edits |

**Disjoint files ⇒ safe to merge in any order after 5.1.**

## Test plan

| File | Cases | Notes |
|---|---|---|
| `apps/server/test/projects-routes.test.ts` (NEW) | 5 | GET/POST /projects happy + 2× 4xx |
| `apps/server/test/session-mutations.test.ts` (NEW) | 6 | POST /sessions + pause/close/resume + 404 + 409 |
| `apps/server/test/events-filtered.test.ts` (NEW) | 5 | session, type, actor, since, combined |
| `apps/server/test/state-graph-edges.test.ts` (NEW) | 8 | state, graph, recovery (3 v0.1 fields only), edges GET, edges POST + 400 |
| `apps/server/test/verify-routes.test.ts` (NEW) | 5 | started, linked_hypothesis_id, cancel, 404, 409 closed |
| `apps/server/test/actors-routes.test.ts` (NEW) | 4 | list, register + event, 400 type, 409 dup |
| `apps/server/test/envelope.test.ts` (NEW) | 3 | success unchanged, error shape, cause sanitized |
| `apps/server/test/phase-5.e2e.test.ts` (NEW) | 1 E2E (13 assertions) | boot → POST → GET state → SSE live → POST /verify → poll → cancel → auth → /health |

**33 unit + 1 E2E (13 assertions).** Combined with existing 8 server cases
+ phase-3 E2E = **~42 cases / 11 files in `@cognit/server`**. Project total
**~470 / 56** (was 432/49 after phase 4).

### Test plan acceptance

- **PASS when** every file in the table above lands with its case count, and `npx turbo run test --force` is green.
- **PASS when** `phase-5.e2e.test.ts` covers the 13-assertion flow including `/health` (assertion 13) and the auth branch.
- **PASS when** `recovery` endpoint asserts only the 3 v0.1 fields.
- **PASS when** `docs/phase-5-results.md` is written, test count delta reported, and the `apps/server` build script is real.

### Coverage gaps (deferred to v0.2)

- SSE slow-consumer / backpressure synthetic frame (no flood harness; drop-oldest is runtime safeguard).
- Long-lived SSE > 1h (heartbeat added in 5.2; no soak test).
- Multi-project routing.
- `cors_origin` allowlist (defer; `*` is safe for local use).
- Token `===` → `timingSafeEqual` swap.

## Parallelism

- **5.1 must land first** (chokepoint). 1 worktree, 1 PR.
- **5.2 + 5.3 + 5.4 + 5.5 + 5.6 + 5.7** independent (disjoint files). 6 parallel worktrees after 5.1.
- **5.8** runs last.

**Wall-clock:** 5.1 (~half day) + max(5.2, 5.3, 5.4, 5.5, 5.6, 5.7) (~1 day each) + 5.8 (~half day) = **~2.5 days**.

## Risks

- **Dashboard origin decision (5.3) couples to phase 6.** Resolves to same-origin :6971. Confirm before 5.3 lands.
- **Inbox→bus consolidation in 5.1 may break db tests that build layers without `EventBus`.** Mitigation: `EventBusNoop` default. If >5 db test files need editing, fall back to "always include `EventBusNoop` in `DbLive`".
- **SSE heartbeat interval (5.2) is an opinion.** 15s is the standard; document in `sse.ts:40`.
- **`POST /verify` async lifecycle (5.6) requires verification package wiring into apps/server Effect runtime.** 5.6 includes the wiring; if missing, 5.8 E2E fails at assertion 7.

## Out of phase 5 scope

- Dashboard UI (phase 6, port :6971 per same-origin decision).
- v0.2 fields on `/recovery` (`related_sessions`, `suggested_next_steps`).
- Multi-actor RLS / per-project ACL.
- Webhooks.
- Hot token rotation.
- `cors_origin` allowlist.
- Background snapshot sweeper (phase 2.5 decision still stands).
- CORS hardening.

## Files to be created or modified

**NEW**

- `plans/phase-5.md` (this file)
- `apps/server/src/routes/projects.ts`
- `apps/server/src/routes/verify.ts`
- `apps/server/src/routes/actors.ts`
- `apps/server/src/routes/edges.ts`
- `apps/server/src/routes/auth.ts`
- `apps/server/src/api-error.ts`
- `apps/server/src/config.ts`
- `packages/cli/src/commands/server.ts`
- `packages/db/src/bus-live.ts`
- `packages/db/src/bus-noop.ts`
- 8 new test files (see test plan)
- `docs/phase-5-results.md`

**MODIFIED**

- `apps/server/src/envelope.ts` (doc only)
- `apps/server/src/routes/events.ts` (filtered /events; events/stream `id:` + heartbeat)
- `apps/server/src/routes/healthz.ts` (export handler for alias)
- `apps/server/src/sse.ts` (id field, Last-Event-ID, replay default, heartbeat, shutdown)
- `apps/server/src/bus.ts` (re-export from db; shutdown added)
- `apps/server/src/auth.ts` (precedence, /health exempt)
- `apps/server/src/index.ts` (mount order, cookie route, /health alias, static serve)
- `apps/server/package.json` (real build script)
- `packages/db/src/inbox.ts` (publish removed — moved to service)
- `packages/db/src/session-service.ts` (consolidated publish)
- `packages/db/src/layers/live.ts` (EventBusLive in default output)
- `apps/server/src/event-queries.ts` (filtered /events query)
