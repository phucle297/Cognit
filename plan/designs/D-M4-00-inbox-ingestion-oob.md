# D-M4-00 — Inbox ingestion: make Cognit work out-of-the-box

**Status:** Proposed (design + plan, no code yet)
**Scope:** Fix the `.cognit/inbox/*.json → SQLite` pipeline so a fresh `cognit init` ingests events with zero extra commands.
**Predecessors:** D-M1-01 (capture signals), D-M3-01 (payload evolution)

---

## 0. Problem statement (from traced implementation)

Two independent blocks prevent any inbox file from reaching SQLite. Both are structural, not data-quality.

**Block A — no consumer ever runs.** The inbox consumer is invoked in exactly one place outside tests: `apps/cli/src/commands/inbox.ts:125` (`drainInbox`, `--process`) and `:145` (`runInboxWatcher`, `--watch`). There is no daemon, no server-side auto-start, no hook that drains, and no `cognit init` background wiring. The `inbox.watch: true` flag in `cognit.yaml` is read by nothing (grep confirms only the CLI option string matches). Forensic proof: `makeInboxWatcher` (`packages/db/src/inbox.ts:155-163`) `mkdir`s `processed/` and `inbox/_error` at start; a real project's `.cognit/` has neither.

**Block B — even if drained, every file is rejected before INSERT.** Hooks (`hooks/claude-code/cc-pre.sh`, `cc-post.sh`) resolve the session id as `COGNIT_SESSION_ID` → `.cognit/current-session` → **placeholder `01HXXX...`**. With no `cognit session create` ever run, the pointer is absent, so the placeholder flows into the envelope. `SessionService.appendEvent` (`packages/db/src/session-service.ts:981-986`) does `fetchSession` → `undefined` → `Effect.fail(UnknownSession)`. The inbox watcher maps that (`inbox.ts:411`) to category `unknown_session_id` and routes the file to `inbox/_error/`. `insertEvent` (`event-store.ts:168`) is never reached.

**Key asymmetry that shapes this plan:** the *CLI write path already works end-to-end.* `apps/cli/src/auto-session.ts::ensureSession` lazy-creates a session on first event for `cognit observation` / `decision` / `verification` / `append` / etc. The M1 contract (`init.ts` CLAUDE.md: *"A session is auto-created on first call"*) is honoured on the CLI path and **violated on the inbox path.** The fix is therefore narrow: bring the inbox path to parity with the CLI path. No new subsystems required.

---

## 1. Inbox consumer lifecycle

### Decision: lazy drain on read commands, keep `--watch` opt-in, no daemon.

**Why not auto-start a watcher:** a long-running background process needs a supervisor (systemd/launchd/Windows service). That is cross-platform surface area, upgrade/restart bugs, port/file-lock contention, and a new failure mode for `cognit doctor` to triage — all to save work that the read path can do incidentally. It violates the local-first, single-process-per-command design that the rest of the CLI follows.

**Why not a daemon:** same cost, plus the existing `--watch` already covers users who genuinely want realtime.

**Chosen mechanism — lazy drain:** add a shared `drainInboxOnce()` Effect and run it at the start of every read/turn command that already builds the app layer:

- `cognit continue` (`commands/continue.ts`) — turn start, primary consumer
- `cognit search` (`commands/search.ts`)
- `cognit events` (`commands/events.ts`)
- `cognit recovery` (`commands/recovery.ts`) — note: talks to server; drain must happen server-side or via a local pre-call
- `cognit show` / session read paths

This makes data **fresh whenever it is consumed**, with zero new processes. It is self-healing: missed drains on one command are caught by the next. `cognit inbox --watch` remains for users who want real-time SSE/dashboard freshness; `cognit inbox --process` remains as the explicit manual flush.

| Question | Answer |
|---|---|
| Started automatically? | Yes — *lazily*, on first read command. Not a background process. |
| Where started? | Shared helper invoked from read-command actions (`commands/{continue,search,events,...}.ts`). |
| Daemon or embedded? | Neither required. `--watch` (chokidar, `inbox.ts:524`) stays as the opt-in realtime path; optional server-hosted watcher is Phase 4. |

**Affected files**
- New: `apps/cli/src/inbox-drain.ts` (shared `drainInboxOnce(root)` helper, wraps `drainInbox` from `@cognit/db`).
- Edit: `commands/continue.ts`, `commands/search.ts`, `commands/events.ts`, `commands/recovery.ts` (prepend drain).
- Source of drain: `packages/db/src/inbox.ts:479 drainInbox` (unchanged).

**Side effects**
- Every read command now does N file reads + appends before answering. Bounded by inbox size; after first drain, inbox is normally empty so cost ≈ one `readdir`. Acceptable.
- Ordering: drain must complete before the query so the answer reflects just-written files. Sequential, not concurrent.
- A crash mid-drain leaves files in place (idempotent re-drain via event `id` dedup in `EventStore.append`).

**Backwards compatible:** yes. Pure additive behaviour on read paths. `--watch`/`--process` semantics unchanged.

---

## 1.5 Architecture principle — unified write entry point (cross-cutting)

> **Single rule: every event source enters the store through exactly one entry point per input shape. No source does its own session-resolution or validation.**

This is the architectural guardrail that prevents the class of drift this whole fix exists to repair. The inbox bug was not a one-off — it is the symptom of session-resolution and validation logic living in multiple places. Patching only the inbox (the original §2 `ensureSession` proposal) would close *this* drift while leaving the structure that produced it intact, so the next source (a new hook, an MCP server, a SDK) would diverge the same way. The principle below makes that structurally harder.

### Current write paths (inventory from grep — this *is* the drift surface)

| Source | Today does | Entry today | Drift? |
|---|---|---|---|
| CLI verbs (`observation`/`decision`/…) | resolve session in `auto-session.ts`, build typed event | `cognition-service` → `SessionService.appendEvent` | session-resolve outside service |
| Inbox watcher (`inbox.ts:350`) | decode envelope + validate + (proposed) resolve session | `SessionService.appendEvent` | **decode+validate+resolve all outside service** |
| Server `POST /events` (`routes/events.ts:262`) | own validation, own session resolution | `SessionService.appendEvent` | resolve outside service |
| Server typed routes (`verify`/`actors`) | pre-resolved session | `SessionService.appendEvent` | clean |
| Server `routes/rules.ts:227,303,358` | none | `EventStore.append` **directly** | bypasses service entirely |
| `packages/agent/src/apply.ts:159,179` | none | `EventStore.append` **directly** | bypasses service entirely |

`SessionService.appendEvent` is *called* the chokepoint, but session resolution is scattered across three callers and two paths skip the service entirely. That is the structural defect.

### Target: three tiers, one entry per shape — all on `SessionService`

```
                          ┌─────────────────────────────────────────┐
  envelope-shaped sources │  SessionService.ingest(envelope)         │   ← NEW, canonical
  (inbox JSON, server     │   resolve/create session                 │      "raw envelope in"
   POST /events, future   │   validate envelope + payload            │
   MCP/SDK)               │   → appendEvent(...)                     │
                          └────────────────┬────────────────────────┘
                                           ▼
                          ┌─────────────────────────────────────────┐
  typed-event sources     │  SessionService.appendEvent(input)       │   EXISTS, canonical
  (CLI verbs via          │   requires resolved session              │      "typed event in"
   cognition-service,     │   constraint check + append + publish    │
   server typed routes)   │   + snapshot                             │
                          └────────────────┬────────────────────────┘
                                           ▼
                          ┌─────────────────────────────────────────┐
  system/internal only    │  EventStore.append(input)                │   INTERNAL escape hatch
  (constraint_rule_added, │   no session lifecycle, no rule check    │   — documented, not public
   agent apply)           │                                           │
                          └─────────────────────────────────────────┘
```

- **`SessionService.ingest(envelope)`** (new) — the single entry for envelope-shaped input. Takes the canonical envelope (the same shape inbox JSON already is), resolves/creates the session (§2 logic lives *here*), validates envelope + payload against the shared schema registry, then calls `appendEvent`. **Inbox and `POST /events` both call this.** No source resolves a session itself.
- **`SessionService.appendEvent(input)`** (exists) — the single entry for already-typed, already-session-resolved input. Runs the constraint engine, appends, publishes on the bus, snapshots. `cognition-service` (the verb layer the CLI uses) and typed server routes stay here — they are *not* drift, they legitimately operate on resolved sessions.
- **`EventStore.append`** (exists, internal) — the only legitimate bypass, for events that by definition must skip the session lifecycle and the pre-append rule check: `constraint_rule_added`/`constraint_rule_applied` (a rule must not require permission from the rule set it is adding — see `session-service.ts:1001`) and `agent/apply.ts` transforms. **Documented escape hatch, not a public entry.** New code does not call it directly; reaching for it requires a comment justifying why the event cannot go through `ingest`/`appendEvent`.

### Canonical envelope — extract, do not duplicate

The envelope schema currently lives inline in `packages/db/src/inbox.ts:69 EnvelopeSchema` (and `PAYLOAD_SCHEMAS_BY_VERSION` in `event-schema.ts`). Extract both to a shared module (e.g. `packages/db/src/envelope.ts`) so inbox, server, and any future source decode against **one** definition. `processFile` then shrinks to: `readFile → JSON.parse → sessions.ingest(parsed)`; all six decode steps (currently `inbox.ts:200-360`) move into `ingest` where they are shared. The failure-category mapping (`mapAppendError`) moves with them, so every source gets identical, consistent error categorisation.

### Why this prevents future drift

- A new source (MCP server, SDK, a second hook format) implements **only** "produce an envelope." It cannot accidentally invent its own session lifecycle or validation because `ingest` owns both.
- Session-resolution logic exists in exactly one place (`ingest`), so the §2 fix and every future session-policy change (fork-on-resume, sticky-pointer semantics, trust scoring) apply to all sources for free.
- The escape hatch (`store.append`) is explicit and commented; drift becomes visible in review rather than implicit.

### Migration scope (kept tight — do not boil the ocean)

- **Phase 1:** introduce `SessionService.ingest` + shared `envelope.ts`; migrate inbox (`processFile`) and server `POST /events`. This is the minimum to fix the bug *and* establish the principle.
- **Already compliant, leave alone:** `cognition-service` + typed server routes (correctly on `appendEvent`); `auto-session.ts` is retired only insofar as its resolution moves into `ingest` (the CLI verbs keep working).
- **Tracked follow-up, not Phase 1:** the two `store.append` bypasses (`routes/rules.ts`, `agent/apply.ts`) are the *intended* escape hatch — no change needed. If a future audit finds non-system events sneaking through `store.append`, that is an OUT-OF-SCOPE FINDING, not a Phase 1 task.

**Affected files (Phase 1 portion):** new `packages/db/src/envelope.ts`; `packages/db/src/session-service.ts` (`ingest` method); `packages/db/src/inbox.ts` (slim `processFile`, remove inline schema + `mapAppendError` → moved); `apps/server/src/routes/events.ts` (call `ingest`).

**Side effects:** inbox and server now share one validation+resolution path, so a schema tightening lands for both simultaneously (intended). Error categories identical across sources.

**Backwards compatible:** yes — `appendEvent` signature unchanged; `ingest` is additive; `store.append` escape hatch preserved. Envelope extraction is a move, not a shape change.

---

## 2. Session bootstrap

### Decision: lazy-create the session on the consumer side, mirroring `auto-session.ts`. Hooks stay dumb.

Three options were considered:

| Option | Pro | Con | Verdict |
|---|---|---|---|
| **(A) Hook-side auto-create** — hook calls `cognit session current`/create before writing envelope | Real session_id in envelope; no DB mutation from consumer | Spawns `cognit` subprocess on **every** Read/Edit/Bash (hooks already spawn `node` for ULID); duplicates `ensureSession` in bash; per-call latency | Rejected |
| **(B) Consumer-side lazy-create** — inbox path creates session on `UnknownSession`, mirroring CLI | One fix point; hooks unchanged; matches M1 contract; CLI already does this | Consumer mutates DB; session goal is synthetic for bootstrap events | **Chosen** |
| **(C) Buffer until session exists** — park files in a pending store, flush when a session appears | Preserves "explicit session" purity | New pending store + flush trigger + ordering concerns; strictly more moving parts than (B) | Rejected |

**Mechanism (Option B), delivered through the unified entry point (§1.5).** Session resolution lives inside `SessionService.ingest`, not in the inbox watcher. `ingest` resolves the session *before* calling `appendEvent`:

1. Resolve a target session id: read `.cognit/current-session` (`current-session.ts`); if absent or stale-closed, mint a new one via `SessionService.create` with goal `cognit-inbox @ <iso>` (or the first observation text if available), actor from the envelope.
2. Write the sticky pointer (`writeCurrentSession`) so subsequent envelopes reuse it.
3. Call `appendEvent` against the resolved session.
4. If append still fails, surface the typed error to the caller (inbox routes to `_error/`, server returns HTTP error) with the real category.

This retires `auto-session.ts::ensureSession`'s resolution logic in favour of the shared `ingest` path — CLI verbs, inbox, and `POST /events` all reach the same session-resolution code. The inbox watcher no longer touches session lifecycle at all; it hands the envelope to `ingest` and reacts to the typed result.

| Question | Answer |
|---|---|
| Hooks auto-create sessions? | No. Hooks keep writing the placeholder; the consumer resolves it. |
| Lazily created on first event? | Yes — exactly the M1 contract, extended to the inbox path. |
| Buffered until a session exists? | No. Lazy-create makes buffering unnecessary. |
| Best fit for current architecture? | Consumer-side lazy-create via a shared `SessionService.ensureSession` chokepoint. |

**Affected files**
- `packages/db/src/session-service.ts` — add `ensureSession(input)` method (create-if-missing + append). Re-use existing `create` (`:610`) and `appendEvent` (`:981`).
- `packages/db/src/inbox.ts:343-361` — replace direct `appendEvent` call with `ensureSession`; update `mapAppendError` (`:400`) so `UnknownSession` is no longer terminal (it triggers the retry inside `ensureSession`, not a sidecar move).
- `apps/cli/src/auto-session.ts` — optionally refactor to delegate to the new `SessionService.ensureSession`, removing duplication.
- Hooks unchanged.

**Side effects**
- Bootstrap sessions get a synthetic goal. Acceptable: the goal is editable later (`session` commands), and the session is real/usable immediately.
- Constraint engine (`session-service.ts:1003`) now runs on bootstrap sessions too — fine, rules default to empty.
- Sticky-pointer races (two terminals) are already last-writer-wins by design (`current-session.ts` header). No new lock needed.

**Backwards compatible:** yes. Existing real sessions are reused unchanged; only the missing-session case changes behaviour (from reject → create). No schema change, no event-version change.

---

## 3. Event ingestion robustness

### 3.1 Prevent unbounded accumulation
- Lazy drain (§1) keeps the inbox near-empty in normal use.
- Add a soft cap + warning: when pending inbox count crosses `inbox.max_pending` (new config, default 1000), read commands log a warning and `cognit doctor` reports it. Hard cap is intentionally *not* enforced (silent data drop violates local-first trust); the warning is the signal.
- `cognit gc` already manages `archive/`/artifacts; extend it to also report/sweep stale `inbox/_error/` files older than `cleanup.artifact_max_age_days`.

### 3.2 Error reporting
- Sidecar `reason.txt` (`inbox-sidecar.ts`) already carries category-prefixed reasons. Keep.
- Add `cognit inbox status`: pending count, `_error/` count, last-drain timestamp (written to `.cognit/inbox/.last-drain`), last-error summary.
- `cognit doctor` (`commands/doctor.ts`): add an "inbox" panel — pending, errored, watcher-running?, session-bound?, with a one-line verdict (HEALTHY / DEGRADED / BROKEN).

### 3.3 Retry behaviour
- Today: failures are terminal → `_error/`. No retry.
- Proposed: only **transient** errors retry, in-process, bounded:
  - `DbError` with SQLITE_BUSY/LOCKED → exponential backoff, max 3 attempts, within the single `drainInbox`/`processFile` call. (better-sqlite3 is sync; contention is brief.)
  - `UnknownSession` → no longer an error after §2 (handled by `ensureSession`).
  - Schema/validation/JSON errors → still terminal (retrying cannot fix a malformed file).
- No cross-restart retry queue (YAGNI); the `_error/` dir + `cognit inbox reprocess` (§6) is the durable retry surface.

### 3.4 Observability
- `Logger` (`packages/db/src/context.ts`) already structured. Surface inbox counts in `cognit doctor` and a new `cognit inbox status`.
- Write `.cognit/inbox/.last-drain` (mtime) on every successful drain so `doctor` can detect a stalled pipeline ("last drain 3 days ago").

**Affected files:** `packages/db/src/inbox.ts` (retry, last-drain stamp), `apps/cli/src/commands/doctor.ts`, new `apps/cli/src/commands/inbox-status.ts` (or subcommand of `inbox`), `packages/core/src/config.ts` (`inbox.max_pending`), `apps/cli/src/commands/gc.ts` (error-dir sweep).

**Side effects:** retry adds at most ~hundreds of ms under contention; capped. Last-drain stamp is a new tiny file (gitignored already — `inbox/` is ignored).

**Backwards compatible:** yes. Retry is additive; terminal categories unchanged for genuine failures.

---

## 4. Startup UX

### Current required commands (broken flow)
1. `cognit init` — creates `.cognit/`, installs hooks, writes CLAUDE.md, bootstraps DB + project row.
2. `cognit session create --goal ...` — *otherwise hooks emit placeholder session and every file is rejected.*
3. `cognit inbox --watch` (or `--process` after every turn) — *otherwise nothing ever reaches SQLite.*
4. …and the placeholder files already written before step 2 are stranded in `inbox/_error/` and must be manually `mv`'d back.

### Target flow (post-fix)
1. `cognit init`.
2. Open Claude Code / any hooked tool. Work normally.
3. `cognit continue` (or `search`/`events`) — drains inbox, auto-binds a session, shows reasoning.

**One command.** No `session create`, no `inbox --watch`, no manual salvage.

### Changes delivering this
- §1 lazy drain removes the `inbox --watch` requirement.
- §2 lazy session removes the `session create` requirement.
- §6 `cognit inbox reprocess` salvages legacy placeholder files so existing `.cognit/` dirs upgrade cleanly.
- `init.ts` final hint updated from the optimistic *"Reasoning will appear in `cognit continue`"* (currently a lie) to an accurate one-liner naming `cognit continue` as the view command and noting auto-session.

**Affected files:** `apps/cli/src/commands/init.ts` (hint text), README/docs (see §5/Phase 3).

**Side effects / compatibility:** none functional. Pure messaging fix.

---

## 5. Configuration — `inbox.watch: true`

### Decision: repurpose, do not remove. Split into two clear knobs.

`inbox.watch` is currently dead. Removing it is cleanest, but it is user-facing config in shipped `cognit.yaml` files; a silent removal surprises upgraders. Instead:

- **`inbox.auto_drain` (new, default `true`)** — read commands drain the inbox first. This is the §1 fix and the knob that makes OOB work. Set `false` only for users who run `--watch` and want read commands to skip the drain.
- **`inbox.watch` (existing)** — re-document as the *real-time-watcher hint*: when `true`, `cognit init` prints a suggestion to run `cognit inbox --watch` (or sets up the Phase 4 supervisor). It does **not** auto-start anything (no supervisor exists in Phases 1–3). Effectively a documentation/prompting knob until Phase 4.

Rationale: keep every existing config valid, add one boolean that actually controls the new behaviour, and stop pretending `watch:true` launches a daemon.

**Affected files:** `packages/core/src/config.ts` (schema + default for `auto_drain`; clarify `watch`), `apps/cli/src/commands/init.ts` (respect `watch` in the post-run hint), docs.

**Side effects:** none at runtime for existing configs (`watch` continues to do nothing automatic; `auto_drain` defaults on, which is the desired OOB behaviour).

**Backwards compatible:** yes — additive field with safe default; existing field semantics narrowed but not broken.

---

## 6. Failure recovery

### `UnknownSession` handling
- **Before §2:** terminal → `_error/`.
- **After §2:** recoverable. `ensureSession` creates the missing session inline and re-appends. The file is **not** moved to `_error/`; it goes to `processed/`.

### Recoverable vs terminal
| Category | Recoverable? | Action |
|---|---|---|
| `unknown_session_id` (UnknownSession/SessionClosed) | **Yes (new)** | `ensureSession` creates/reopens; re-append |
| `invalid_json` | No | `_error/` |
| `schema_validation_failure` (envelope/payload) | No | `_error/` |
| `invalid_actor_type` / `invalid_envelope` | No | `_error/` |
| `actor_not_registered` (ConstraintViolation) | No (policy) | `_error/` |
| `internal_db_error` (DbError transient) | **Yes (new)** | bounded in-process backoff, then `_error/` if still failing |
| `internal_db_error` (DbError permanent: corruption/disk) | No | `_error/` + `doctor` flags BROKEN |

### Should the consumer auto-create the missing session?
**Yes** — that is §2. Bounded to the bootstrap case (no session bound yet). It never silently reopens a *closed* session into a different goal; `SessionClosed` routes to `ensureSession` which mints a fresh session rather than resurrecting.

### Retry instead of immediate `_error/`?
Only for transient `DbError` (§3.3). For everything else, the durable retry surface is `cognit inbox reprocess`:

- **`cognit inbox reprocess` (new)** — re-runs `processFile` over every file in `inbox/_error/`. After a Cognit upgrade that fixes a schema/handling bug, or after the §2 fix lands, this salvages legacy errored files (including the 26 placeholder-session files in the field today) without manual `mv`. Files that succeed move to `processed/`; files that still fail get an updated `reason.txt` (idempotent re-run).

**Affected files:** `packages/db/src/inbox.ts` (add `reprocessErrorDir` analogous to `drainInbox`), `apps/cli/src/commands/inbox.ts` (new `--reprocess` option), `session-service.ts` (`ensureSession`).

**Side effects:** `reprocess` re-runs constraint rules on old events — safe because rules are evaluated against reconstructed state and idempotent event ids dedup.

**Backwards compatible:** yes.

---

## 7. Testing

Mapped to the existing test file `packages/db/test/inbox.test.ts` (already exercises `makeInboxWatcher`/`processFile` extensively) plus new CLI integration tests.

### Unit (`packages/db/test/inbox.test.ts` + `session-service.test.ts`)
- **U1** `processFile` with no bound session → session auto-created, event appended, file moved to `processed/`. (§2)
- **U2** `processFile` with a valid active sticky pointer → reuses session, no new row. (§2)
- **U3** `processFile` with a *closed* sticky-pointer session → mints new session (does not resurrect). (§2/§6)
- **U4** `ensureSession` is idempotent: two files in one drain → one session, two events. (§2)
- **U5** `drainInbox` empty-inbox → `{processed:0, errored:0}`, no side effects. (§1)
- **U6** `drainInbox` mixed: valid + invalid_json + bad-envelope → correct counts, files in right dirs. (existing coverage, keep)
- **U7** `DbError` SQLITE_BUSY → retried up to N, succeeds on retry; exhausted → `_error/` with `internal_db_error`. (§3.3)
- **U8** Validation failures still terminal (regression guard): unknown `(version,type)` → `schema_validation_failure`. (§6)
- **U9** `reprocessErrorDir`: a previously-errored file now succeeds after fix → moves `inbox/_error/` → `processed/`. (§6)
- **U10** Last-drain stamp written; `doctor`/`inbox status` read it. (§3.4)

### Integration / CLI (`apps/cli/tests/` — startup, watcher, recovery)
- **I1** Fresh-project OOB: `cognit init` → drop a hook-style envelope into `inbox/` → `cognit continue` → assert event in SQLite + file in `processed/`. (§1+§2+§4)
- **I2** Lazy drain fires on `continue`, `search`, `events`; verify each ingests pending files before answering. (§1)
- **I3** `cognit inbox --watch` still realtime-ingests a file written while watching. (regression, §1)
- **I4** `cognit inbox --process` one-shot drains and exits with correct counts. (regression)
- **I5** Placeholder-session salvage: seed `inbox/` with 26 `01HXXX...` envelopes → `cognit continue` → all ingested under one bootstrap session. (§2/§6, the reported field bug)
- **I6** `cognit inbox reprocess` clears a synthetic `_error/` dir after a simulated fix. (§6)
- **I7** `cognit doctor` reports HEALTHY on a drained project, DEGRADED with N pending > cap, BROKEN on DB error. (§3.2/§3.4)
- **I8** Concurrency: two `cognit continue` in parallel → no double-insert (event-id dedup), no pointer corruption. (§2)
- **I9** `inbox.auto_drain=false` → read commands skip drain (config honoured). (§5)
- **I10** Startup UX: after `cognit init`, no further command is required for ingestion (golden path E2E). (§4)

### Regression / golden replay
- Extend the golden-replay harness (D-M1-00) with a fixture containing placeholder-session envelopes to lock the salvage behaviour against future drift.

---

## 8. Phased delivery

### Phase 1 — Critical bug fixes (make the pipeline work)
- 1.0 **Unified entry point (§1.5):** extract shared `packages/db/src/envelope.ts` (envelope schema + payload registry + `mapAppendError`); add `SessionService.ingest(envelope)` (session resolve/create + validate + `appendEvent`). Slim `inbox.ts:processFile` to `read → parse → ingest`. Migrate server `POST /events` to `ingest`.
- 1.1 Session lazy-create delivered *inside* `ingest` (§2) — retires the inbox-side resolution and the `auto-session.ts` divergence.
- 1.2 Shared `drainInboxOnce` helper + wire into `continue`/`search`/`events` (§1).
- 1.3 `cognit inbox reprocess` to salvage legacy placeholder files (§6).
- 1.4 `init.ts` hint corrected (§4).

**Complexity:** Medium.
**Risk:** Medium — touches `SessionService` (shared chokepoint for CLI + inbox + server) and the inbox decode/append path; must preserve idempotency and the constraint-engine ordering. The §1.5 refactor consolidates three scattered responsibilities into one method — the risk is migrating inbox + server `POST /events` without changing externally observable error categories.
**Mitigation:** implement `ingest` as `resolve-session → validate → appendEvent` composition (all three already tested in isolation); exhaustive unit suite U1–U4 + the shared-envelope decode tests before wiring any caller; keep `mapAppendError` categories byte-identical so sidecars/HTTP responses don't change shape.
**Expected impact:** High — unblocks all ingestion; the reported "nothing in SQLite" failure is resolved *and* the drift that caused it is closed structurally, not just for inbox.

### Phase 2 — Reliability improvements
- 2.1 Bounded retry for transient `DbError` (§3.3).
- 2.2 `cognit inbox status` + `doctor` inbox panel + last-drain stamp (§3.2/§3.4).
- 2.3 Pending-cap warning + `gc` sweep of stale `_error/` (§3.1).

**Complexity:** Low–Medium.
**Risk:** Low — additive observability + bounded retry; no core path changes.
**Expected impact:** Medium — makes failures visible and self-healing instead of silent.

### Phase 3 — UX improvements
- 3.1 Config: `inbox.auto_drain` (default on) + clarified `inbox.watch` (§5).
- 3.2 Docs/README rewrite for the one-command OOB flow (§4).
- 3.3 `doctor` one-line verdict + `init` post-run accuracy pass.

**Complexity:** Low.
**Risk:** Low.
**Expected impact:** Medium — sets correct expectations; removes the "open Claude Code and magic happens" friction.

### Phase 4 — Nice-to-have enhancements
- 4.1 Optional per-hook fire-and-forget `cognit inbox --process` (config `inbox.realtime`, default off) for near-realtime without a daemon (§1 alt).
- 4.2 Supervisor generator (`cognit inbox --install-watch` → systemd/launchd unit) for headless/CI (§1).
- 4.3 Server-hosted watcher: when `cognit server` is running and `inbox.watch:true`, the Hono server runs `runInboxWatcher` in-process (covers the dashboard/SSE realtime case properly).
- 4.4 Hook latency budget + telemetry; consider collapsing the `node` ULID mint into the python atomic-write to drop one subprocess per hook fire.

**Complexity:** Medium–High.
**Risk:** Medium — daemons/supervisors and server lifecycle are the classic 3am-paging surface; gated behind opt-in flags.
**Expected impact:** Low–Medium — polish for power users; not required for OOB.

---

## 9. Out of scope (do-not-change guardrails)

- Event payload schemas (`event-schema.ts`) — the `tool:"unknown"` payloads are valid; do not "fix" them.
- Envelope version literals — no new version needed.
- Redaction, gravity scoring, constraint DSL — untouched by this work.
- The atomic-write protocol in the hooks (`open(wx)→write→fsync→rename`) — correct, keep.
- The `EventStore.append` bypass in `apps/server/src/routes/rules.ts` and `packages/agent/src/apply.ts` — this is the **deliberate escape hatch** for system events that must skip the session lifecycle (§1.5). Do not "fix" it by routing through `ingest`/`appendEvent`; that would reintroduce the rule-check recursion `session-service.ts:1001` guards against.

Per `plan/07-do-not-change.md`, any drift into these areas during implementation must be reported as an OUT-OF-SCOPE FINDING, not fixed inline.

---

## 10. Summary table

| Issue (§) | Fix | Phase | Files |
|---|---|---|---|
| 1.5 **unified write entry** | `SessionService.ingest` + shared `envelope.ts`; one entry per input shape | 1 | `envelope.ts` (new), `session-service.ts`, `inbox.ts`, `routes/events.ts` |
| 1 consumer lifecycle | lazy drain on read | 1 | `inbox-drain.ts` (new), `commands/{continue,search,events}.ts` |
| 2 session bootstrap | lazy-create inside `ingest` | 1 | `session-service.ts`, `inbox.ts` |
| 3 robustness | retry + status + caps | 2 | `inbox.ts`, `doctor.ts`, `gc.ts`, `config.ts` |
| 4 startup UX | one-command flow | 1+3 | `init.ts`, docs |
| 5 config | `auto_drain` + clarify `watch` | 3 | `config.ts`, `init.ts` |
| 6 recovery | reprocess + recoverable UnknownSession | 1+2 | `inbox.ts`, `commands/inbox.ts` |
| 7 testing | U1–U10, I1–I10 | all | `packages/db/test/`, `apps/cli/tests/` |
