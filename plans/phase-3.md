# Phase 3 Implementation Plan — Cognition-Entity CLI, Sticky Session + JSON, Constraint Engine, and Agent Read API

Date: 2026-06-15

## TL;DR

Phase 3 closes the operator-CLI gap (cognition-entity commands, sticky
current-session, `--json` output), wires the half-wired constraint
engine to its existing event types, and lands the agent read API in
`apps/server` (Hono) — four self-contained epics that ship the
overdue v0.1 bootstrap surface on top of the phase 2.5 trigger.

## Status

- **Shipped (phase 0-2.5)**: Cognit CLI skeleton; SQLite + event store
  + redaction boundary; chokidar inbox watcher; pure reducer in
  `packages/core`; `SessionService` / `SnapshotService` / `ProjectService`
  in `packages/db`; CLI `session / snapshot / append / inbox`; inline
  auto-snapshot every N events via `SessionPolicy`; resume-as-fork.
  184 tests (103 db / 37 cli / 44 core). In-DB `state_json` snapshots
  are the v0 source of truth.
- **Deferred from phase 1-2.5 (carried into phase 3)**: sticky
  current-session flag, `--json` output mode, fuse.js fuzzy match,
  constraint engine, HTTP/MCP read surface, snapshot file mirror.
- **This phase (phase 3)** ships four epics:
  - 3a — cognition-entity CLI (observation/finding/hypothesis/theory/
    experiment/decision/conclusion/edge/verify) plus a `CognitionService`
    in `@cognit/db`.
  - 3b — sticky current-session pointer + `--json` output mode (the
    twice-deferred v0.1 ergonomics).
  - 3c — constraint engine: rule DSL in core, eval hook in
    `appendEvent`, `cognit constraint {add,list,test}` CLI. Trust
    recompute is deferred to a follow-up.
  - 3d — agent read API in `apps/server`: Hono routes
    `GET /sessions/:id/state`, `GET /events/stream` (SSE),
    `POST /events` (funnelled through `appendEvent`), per-project bearer
    token, in-process event bus. No dashboard. No MCP shim yet (a thin
    MCP layer over the same routes is a documented follow-up).
- **Out of phase 3 (deferred to phase 4 / v0.2)**: Vite+React dashboard,
  reasoning traces (`thought_logged`), webhooks, multi-actor RLS,
  incremental snapshots, fuse.js / semantic search, background
  snapshot sweeper, snapshot file mirror, per-event `from_event_id`
  fork, MCP transport, `cognit doctor` / `cognit gc` (operator-UX
  follow-ups), atomic-write enforcement flag, v0.1 release artifact.

## Goals

1. Make `cognit observe "..."` and `cognit propose "..."` first-class
   — every cognition entity in `plan.xml <bootstrap_phases>` 3-4 has
   a dedicated subcommand; no `--type ... --payload '{...}'` for the
   common path.
2. Sticky current-session: `cognit session create "goal"` writes
   `.cognit/current-session`; subsequent `cognit append` (no
   `--session`) succeeds against that session. Pair with a
   stable `--json` envelope (`{ version: 1, data: ... }`) for every
   command.
3. Make `constraint_rule_added` / `constraint_rule_applied` (already
   in `packages/db/src/event-schema.ts:189-190` and
   `packages/db/src/schema/tables.ts:101`) do real work: a typed
   rule DSL in `packages/core`, an `appendEvent` hook that emits
   `constraint_rule_applied` on match, and a CLI to add/list/test
   rules.
4. Stand up a Hono server in the existing `apps/server` scaffold
   that exposes session state over HTTP, streams new events via SSE
   backed by an in-process bus, and accepts `POST /events` going
   through the same `appendEvent` redaction boundary the CLI uses.

## Subtasks

### 3a — `CognitionService` in `packages/db` + `cognit {observation,finding,hypothesis,theory,experiment,decision,conclusion,edge,verify}` CLI (slice: observation first, then entities)

- **Scope (in)**: `CognitionService` Context.Tag with one method per
  entity (`recordObservation`, `recordFinding`, `proposeHypothesis`,
  `weakenHypothesis`, `rejectHypothesis`, `promoteHypothesis`,
  `addTheory`, `mergeTheory`, `archiveTheory`, `addExperiment`,
  `completeExperiment`, `proposeDecision`, `acceptDecision`,
  `rejectDecision`, `proposeConclusion`, `verifyConclusion`,
  `rejectConclusion`, `addEdge`, `verify`, `cancelVerification`).
  Each method calls `EventStore.append` with the typed payload
  schema from `packages/db/src/event-schema.ts`. CLI subcommands
  one-per-entity under `packages/cli/src/commands/<entity>.ts`. The
  service builds the payload from positional args, not from a raw
  JSON string.
- **Files to touch**:
  - NEW `packages/db/src/cognition-service.ts`
  - NEW `packages/db/test/cognition-service.test.ts`
  - NEW `packages/cli/src/commands/{observation,finding,hypothesis,theory,experiment,decision,conclusion,edge,verify}.ts`
  - EDIT `packages/db/src/layers/live.ts` (add to leafs)
  - EDIT `packages/db/src/index.ts` (re-export)
  - EDIT `packages/cli/src/index.ts` (register new commands)
  - EDIT `packages/cli/src/layer-build.ts` (wire service)
  - NEW `packages/cli/test/{observation,finding,hypothesis,decision,conclusion,edge,verify}.test.ts`
- **done_when**: `cognit observe "got NPE in UserService" --session <id>`
  appends a valid `observation_recorded` event in <500ms; the same
  flow works for `cognit finding`, `cognit propose "h"`,
  `cognit decide "d"`, `cognit conclude "c"`, `cognit edge add
  --from <id> --to <id> --kind supports`, `cognit verify <id> --result
  passed`. `cognit --help` lists every command in `plan.xml
  <bootstrap_phases>` 3-4 except `gc`/`export`/`import`/`wrap`/
  `redaction test` (deferred). `cognit session show <id>` reflects
  every new entity.
- **Deps**: phase 2.5 closed (`Cognit-04i`); `SessionService.appendEvent`
  is the single redaction boundary; `EventStore.append` already
  accepts the typed payload schemas.

### 3b — Sticky current-session pointer + global `--json` output mode

- **Scope (in)**: `.cognit/current-session` is a plain text file
  holding the active session ULID. `cognit session create` and
  `cognit session resume` write the pointer on success; `cognit
  session close` clears it; `cognit session pause` keeps it (so
  subsequent `cognit append` still works against a paused session).
  `cognit append`, `cognit inbox --process`, the 3a entity
  subcommands, and `cognit snapshot` resolve `--session` from the
  pointer when the flag is missing; an explicit `--session` always
  wins. **Write strategy: atomic rename** — write to
  `.cognit/current-session.tmp`, fsync, rename. Concurrent
  `session create` from two terminals is benign: both writes
  succeed at the FS level, last-writer-wins on read. The
  pointer is a *convenience*, never a contract — `--session` is
  always authoritative, and a stale pointer (mtime > 24h ago)
  prints a warning when resolved. **Decision: no file lock, no
  CRDT, no OT** — those are overkill for a single ULID string;
  atomic rename + mtime warning covers the real failure modes.
  Global `--json` flag on the program: every command's printer
  switches to a stable JSON envelope
  `{ version: 1, kind: "<command>", data: ... }`. `cognit schema-dump`
  prints the envelope shape as TypeScript types.
- **Files to touch**:
  - NEW `packages/cli/src/paths.ts` (path helpers for `.cognit/`)
  - NEW `packages/cli/src/output.ts` (`OutputMode` type, `envelope()`,
    table-to-JSON helper)
  - NEW `packages/cli/src/current-session.ts` (read / write-atomically
    / clear; mtime check on read)
  - EDIT `packages/cli/src/commands/session.ts` (write pointer on
    create/resume; clear on close; keep on pause)
  - EDIT `packages/cli/src/commands/append.ts`, `inbox.ts`,
    `observation.ts`, `finding.ts`, ..., `snapshot.ts` (resolve
    `--session` from pointer)
  - EDIT `packages/cli/src/index.ts` (program-level `--json`,
    `--log-format`, `--log-level`)
  - NEW `packages/cli/test/sticky-session.test.ts`,
    `json-output.test.ts`, `schema-dump.test.ts`
- **done_when**: `cognit session create "x" --root <p>` writes
  `.cognit/current-session`; subsequent `cognit append --type
  observation_recorded --payload '{"text":"y"}'` (no `--session`)
  appends to that session; `cognit --json session show <id>` prints
  `{version:1, kind:"session.show", data:{...}}` parseable by
  `jq .data.id`. Closing clears the pointer; a pointer with
  mtime > 24h ago prints a warning ("pointer stale, run
  `cognit session list` or pass `--session <id>`") but does NOT
  error (the user might genuinely be resuming old work).
  An explicit `--session` overrides the pointer silently.
  Concurrent writers race-test: two `session create` in parallel
  → both succeed, the file ends with one of the two values, no
  partial-read corruption (atomic rename assertion in test).
- **Deps**: 3a (the new entity commands need the pointer resolution
  to land before they can be ergonomic).

### 3c — Constraint engine: typed rule DSL in `packages/core` + `appendEvent` hook + `cognit constraint {add,list,test}` CLI

- **Scope (in)**: `packages/core/src/constraint-dsl.ts` defines the
  rule shape (`{ when: <predicate>, then: <action>, reason: string }`)
  with a **closed v1 predicate vocabulary** typed via Effect-Schema.
  The v1 set (10 predicates): `event.type ==`, `event.payload.<field>
  ==`, `actor.trust_score >=`, `actor.trust_score <`,
  `state.open_hypotheses.length >`, `state.open_verifications.length
  ==`, `state.last_verification.status ==`,
  `state.accepted_decisions.count >=`, `session.event_count >`,
  `time.since_last_verification >`. **Decision: closed vocabulary
  in v1**, not extensible DSL. New predicates ship as a core
  schema version bump (the existing `PAYLOAD_SCHEMAS_V1` /
  `CURRENT_VERSION` pattern handles this cleanly). The alternative
  — a fully user-extensible predicate language — is a footgun
  (untyped eval, surprise perf) and the project already has the
  "extend via schema version" convention. `packages/db/src/constraint-
  engine.ts` is a pure `evalRules(rules, state, candidateEvent) ->
  { allow: boolean, appliedRuleIds: string[] }`. `EventStore.append`
  runs the engine after the reducer applies the event but before
  the tx commits; on `allow = false`, the tx rolls back and a
  `ConstraintViolation { rule_id, reason }` error is returned. On
  `allow = true` with non-empty `appliedRuleIds`, the same tx also
  inserts a `constraint_rule_applied` event per rule id.
  `cognit constraint add --json '{...}'`, `cognit constraint list`,
  `cognit constraint test <event-type>` CLI subcommands.
- **Files to touch**:
  - NEW `packages/core/src/constraint-dsl.ts`
  - NEW `packages/core/test/constraint-dsl.test.ts`
  - NEW `packages/db/src/constraint-engine.ts`
  - EDIT `packages/db/src/event-store.ts` (`append` runs the engine
    inside the same tx, after reducer apply, before commit)
  - EDIT `packages/core/src/reducer.ts` (extend `SessionState` with
    `applied_rule_ids: Set<string>`; populate on
    `constraint_rule_applied`)
  - EDIT `packages/db/src/errors.ts` (add `ConstraintViolation`)
  - EDIT `packages/db/src/layers/live.ts` (provide engine to
    `appendEvent` via a thin `ConstraintPolicy` Context.Tag built
    once at CLI/server boot)
  - NEW `packages/db/test/constraint-engine.test.ts`,
    `event-store-constraint.test.ts`
  - NEW `packages/cli/src/commands/constraint.ts`
  - NEW `packages/cli/test/constraint.test.ts`
- **done_when**: `cognit constraint add --json '{"when":{"event.type":
  "hypothesis_promoted"}, "then":{"state.open_verifications.length":
  0}, "reason": "unverified promotion"}' --session <id>` appends a
  `constraint_rule_added` event; the next `cognit propose --promote
  <h>` (or `decision accept`) attempt that violates the rule fails
  with a `ConstraintViolation` error carrying the rule id and
  reason; matching, non-blocking events emit a
  `constraint_rule_applied` event in the same tx.
  `cognit constraint test` dry-runs the engine against the existing
  session state and prints which prior events would have been
  blocked.
- **Deps**: 3a (`CognitionService.proposeHypothesis` etc. exist so the
  rule predicates have a real call site); 3b (CLI shell is unified).

### 3d — Agent read API in `apps/server`: Hono routes, in-process event bus, opt-in auth

- **Scope (in)**: `apps/server/src/index.ts` boots Hono on
  **`127.0.0.1:6971`** (API port; UI/dashboard, when it lands in a
  later phase, will use `:6970`) via `Effect.runPromise(buildAppLayer
  (...)).pipe(Layer.launch)`. Routes: `GET /healthz`, `GET /sessions`
  (list, cursor-paginated), `GET /sessions/:id/state` (returns
  `SessionStateView` — same shape as `cognit session show`), `GET
  /sessions/:id/events?after=<id>` (cursor-paginated event log),
  `GET /events/stream` (SSE; replays the last N events on connect,
  then live-subscribes), `POST /events` (validates against the
  same Effect-Schema payload set as the CLI, funnels through
  `EventStore.append` — never a parallel write path). **Auth
  model: opt-in bearer only.** Default bind is `127.0.0.1`, which
  is OS-isolated — no auth is required and `curl` works without a
  token. If the user sets `server.api_token` in `cognit.yaml` and
  binds the server to a non-loopback interface (`--host 0.0.0.0`
  flag or `server.host: 0.0.0.0` config), the bearer middleware
  activates and rejects requests with `401` when the token is
  missing/wrong. **Decision: no auth for the local case.** The
  server is local-first; a `127.0.0.1` bind is the security
  boundary, and adding a token check on top is friction without
  benefit. The opt-in path covers the future "MCP server bound
  to LAN" case. `apps/server/src/bus.ts` is a typed
  `EventEmitter<{ eventInserted: EventRow }>` that the inbox
  watcher and `EventStore.append` push into; the SSE handler
  subscribes; per-subscriber cursor.
- **Files to touch**:
  - NEW `apps/server/src/index.ts` (boot, default `127.0.0.1:6971`,
    `--host` / `--port` flags)
  - NEW `apps/server/src/routes/` (`sessions.ts`, `events.ts`,
    `state.ts`, `healthz.ts`)
  - NEW `apps/server/src/bus.ts`
  - NEW `apps/server/src/auth.ts` (bearer middleware, only when
    `server.api_token` is set in config AND bind != loopback)
  - NEW `apps/server/src/sse.ts` (SSE handler with replay-then-live
    cursor)
  - NEW `apps/server/src/layer-build.ts` (compose db + server)
  - EDIT `packages/db/src/inbox.ts` (push to bus on successful
    append, alongside the chokidar callback)
  - EDIT `packages/db/src/event-store.ts` (`append` returns the
    inserted `EventRow` to the caller — already the case per
    phase 2.5; no signature change, just route the returned row
    to the bus)
  - EDIT `packages/core/src/reducer.ts` (export `project(state)
    -> SessionStateView` — pure, unit-testable, shared between
    server and CLI `session show`)
  - NEW `packages/core/src/view.ts` (`SessionStateView` type)
  - NEW `apps/server/test/` (`healthz.test.ts`,
    `sessions-routes.test.ts`, `sse-bus.test.ts`,
    `post-events-redaction.test.ts`, `auth-bearer.test.ts`)
  - EDIT `apps/server/package.json` (add `hono`, `@hono/node-server`,
    `@cognit/db`, `@cognit/core` deps)
  - EDIT `turbo.json` / root `package.json` (wire
    `apps/server` into the build pipeline)
  - EDIT `STACK.md` (note Hono + @hono/node-server)
- **done_when**: `cognit --root <p> server` boots on
  `127.0.0.1:6971`; `curl localhost:6971/healthz` returns `200 OK`
  *without* a token (default, no auth); `curl localhost:6971/sessions`
  returns the session list as `{ version: 1, data: [...] }` without
  a token; `curl localhost:6971/sessions/<id>/state` returns the
  typed `SessionStateView`; `curl -N localhost:6971/events/stream`
  receives every new event as the inbox watcher accepts it
  (replays last 50, then live). `curl -X POST -H "Content-Type:
  application/json" -d '{"type":"observation_recorded",
  "payload":{"text":"y"}, "session_id":"<id>",
  "actor":"name:human"}' localhost:6971/events` writes a row via
  the same `appendEvent` redaction boundary the CLI uses, and a
  `redaction_applied` event fires when the payload matches a
  redaction pattern (asserted in test). **Auth path** (separate
  test): with `server.api_token: "secret"` in `cognit.yaml` AND
  `cognit server --host 0.0.0.0`, `curl` without
  `Authorization: Bearer secret` returns `401`; with the header,
  it returns `200`. With the token set but bind still `127.0.0.1`,
  auth remains off (loopback is the security boundary; document
  this in STACK.md).
- **Deps**: 3a (the read path uses `CognitionService` for projected
  views); 3c (the `POST /events` route respects the
  `ConstraintViolation` path).

## Out of scope (explicit deferrals)

- **Background snapshot sweeper** (rejected — phase 2.5 architecture
  decision was "inline trigger, not a background task"; revisit when
  the v0.1 server can host it).
- **Incremental snapshots** — measure first, then optimise; the 100ms-
  at-10K-events target should be benchmarked before redesigning the
  snapshot format.
- **Multi-actor RLS / per-project ACL** — premature for a single-actor
  CLI; defer to v0.2.
- **Vite + React dashboard** — explicitly out of phase 3; the
  `apps/dashboard` scaffold remains empty until a future phase
  defines the surface.
- **MCP transport** — the HTTP API in 3d is a stable substrate; an
  MCP shim is a thin wrapper and goes in a follow-up.
- **Reasoning traces (`thought_logged`)** and **webhooks** —
  out-of-spec for the v0.1 bootstrap.
- **Fuse.js / semantic search** — explicit v0.2.
- **Snapshot file mirror to `.cognit/snapshots/<id>.json`** — in-DB
  `state_json` is the v0 source of truth; mirror is v0.2.
- **`cognit doctor` / `cognit gc` / `cognit project info`** — operator
  UX improvements; filed as phase 4 follow-ups.
- **Per-event `from_event_id` fork** — phase 2 ships session-level
  fork only; event-level fork is a v0.2 feature.
- **Atomic-write enforcement flag** — config knob only; code-level
  enforcement is post-v0.1.
- **v0.1 release artifact** (CHANGELOG, migration guide, GitHub
  release) — phase 4.

## Risks

- **3a subtask count** — 7+ new CLI files plus the
  `CognitionService`. Mitigation: ship the `CognitionService` shell
  + `observation` only in bead 3a-1, then per-entity follow-up beads
  (3a-2 ... 3a-7) that each ship behind their own quality gate.
- **3c coupling to reducer** — the `appendEvent` hook is the
  redaction boundary; adding a constraint check inside the same
  tx is structurally identical to the phase 2.5 auto-snapshot
  helper. Mitigation: lift the shared structure behind a single
  `appendWithSideEffects(events, sideEffects)` only after the
  constraint work lands and the pattern is concrete. Don't refactor
  speculatively.
- **3d SSE in-process** — the bus is per-`cognit server` process; a
  separate CLI invocation cannot subscribe. Mitigation: document
  as a v0.1 limitation; multi-process fanout uses the inbox file
  as the IPC primitive (post-v0.2).
- **3d `POST /events` parallel write path risk** — the route must
  route through `EventStore.append`, not raw SQL. Mitigation: a
  route-level test asserts the redaction boundary is still
  enforced when a redaction pattern matches the HTTP payload.
- **3b JSON output contract** — once an external tool depends on
  `--json`, the envelope is a public contract. Mitigation: pin
  `version: 1` in the envelope, ship `cognit schema-dump`, and
  require a major bump for breaking changes.

## Acceptance criteria (the done_when for the whole phase)

The phase 3 epic closes when **all four** of the following are true
and tested in the E2E suite:

1. `cognit observe "x" --session <id>` and every other cognition-
   entity subcommand listed in `plan.xml <bootstrap_phases>` 3-4
   (except `gc`/`export`/`import`/`wrap`/`redaction test`) appends
   a valid event in <500ms; `cognit session show <id>` reflects
   the new entity. `cognit --help` lists every shipped command.
2. `cognit session create "goal"` writes `.cognit/current-session`
   (atomically: tmp → fsync → rename); the next `cognit append`
   with no `--session` appends to that session. `cognit --json
   session show <id>` returns a parseable
   `{ version: 1, kind: "session.show", data: ... }` envelope.
3. `cognit constraint add ...` followed by an event that violates
   the rule fails with a `ConstraintViolation` error and writes no
   event; non-violating events that match a non-blocking rule
   produce a `constraint_rule_applied` event in the same tx.
4. `cognit server` boots on `127.0.0.1:6971`; `curl /healthz`
   returns `200` *without* a token (default, no auth on loopback);
   `GET /sessions/:id/state` returns the typed `SessionStateView`;
   `GET /events/stream` (SSE) delivers new events from the inbox
   watcher within 1s; `POST /events` writes via `appendEvent`
   (redaction + constraint still enforced). When run with
   `--host 0.0.0.0` and `server.api_token` set, requests without
   the bearer return `401`.

Test count target: 130+ db / 60+ cli / 50+ core / 10+ server
(roughly +25 db / +20 cli / +6 core / +10 server over the
phase 2.5 baseline of 103 / 37 / 44 / 0). E2E coverage in
`packages/cli/test/phase-3.e2e.test.ts` and
`apps/server/test/phase-3.server.e2e.test.ts`.

## Decisions (resolved 2026-06-15)

- **3d ports** — API: `127.0.0.1:6971`. UI/dashboard (future phase):
  `:6970`. Phase 3 ships API only; both ports documented in
  `STACK.md` so the dashboard phase has an obvious home.
- **3c rule vocabulary** — **closed v1 set of 10 predicates**, new
  predicates ship as a core schema version bump (mirrors the
  existing `PAYLOAD_SCHEMAS_V1` / `CURRENT_VERSION` migration
  pattern). A user-extensible DSL was rejected as a footgun.
- **3b sticky-session race** — **atomic rename write + LWW read +
  mtime-stale warning**. No file lock, no CRDT, no OT. The pointer
  is a convenience (the contract is `--session`); atomic rename
  prevents partial reads, and the 24h mtime warning catches the
  "I forgot I switched sessions" foot-gun.
- **3a first slice** — **observation first.** Single payload field
  (`text`), no state machine, no verification chain. Validates the
  `CognitionService` shape (positional args → typed payload → call
  to `EventStore.append`) before tackling the hypothesis lifecycle
  (4 states) or decision lifecycle (4 states). Per-entity follow-up
  beads (3a-2 .. 3a-7) ship behind their own quality gate.
- **3d auth** — **opt-in bearer only, off by default on loopback.**
  `127.0.0.1` bind is the security boundary for phase 3; the server
  is local-first and a token check on top is friction without
  benefit. Auth activates only when *both* `server.api_token` is
  set in `cognit.yaml` AND the server is bound to a non-loopback
  interface (`--host 0.0.0.0` or `server.host: 0.0.0.0`). This
  covers the future "MCP server bound to LAN" case without
  burdening local dev.
