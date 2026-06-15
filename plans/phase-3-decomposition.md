# Phase 3 Decomposition — sub-bead map + dependency graph

Date: 2026-06-15 (rev. 1 — post plan-review, dropped inflated deps + added 3 commands)
Master plan: `plans/phase-3.md`
Epic: `Cognit-5vl`

## Sub-bead map (rev. 1)

| ID | Title | Deps | Files (new) | Files (edit) |
|---|---|---|---|---|
| Cognit-5vl.1 | 3a-1: CognitionService shell + observation CLI | — | `packages/db/src/cognition-service.ts`, `packages/db/test/cognition-service.test.ts`, `packages/cli/src/commands/observation.ts`, `packages/cli/test/observation.test.ts` | `packages/db/src/layers/live.ts`, `packages/db/src/index.ts`, `packages/cli/src/index.ts`, `packages/cli/src/layer-build.ts` |
| Cognit-5vl.2 | 3a-2: finding CLI (recordFinding) | Cognit-5vl.1 | `packages/cli/src/commands/finding.ts`, `packages/cli/test/finding.test.ts` | `packages/cli/src/index.ts` |
| Cognit-5vl.3 | 3a-3: hypothesis CLI (4-state lifecycle) | Cognit-5vl.1 | `packages/cli/src/commands/hypothesis.ts`, `packages/cli/test/hypothesis.test.ts` | `packages/cli/src/index.ts` |
| Cognit-5vl.4 | 3a-4: theory + experiment CLI | Cognit-5vl.1 | `packages/cli/src/commands/theory.ts`, `packages/cli/src/commands/experiment.ts`, `packages/cli/test/{theory,experiment}.test.ts` | `packages/cli/src/index.ts` |
| Cognit-5vl.5 | 3a-5: decision CLI (4-state lifecycle) | Cognit-5vl.1 | `packages/cli/src/commands/decision.ts`, `packages/cli/test/decision.test.ts` | `packages/cli/src/index.ts` |
| Cognit-5vl.6 | 3a-6: conclusion + verification + artifact + verify-cancel CLI | Cognit-5vl.1 | `packages/cli/src/commands/conclusion.ts`, `packages/cli/src/commands/verification.ts`, `packages/cli/src/commands/artifact.ts`, `packages/cli/test/{conclusion,verification,artifact}.test.ts` | `packages/cli/src/index.ts` |
| Cognit-5vl.7 | 3a-7: edge CLI (addEdge + listEdge) | Cognit-5vl.1 | `packages/cli/src/commands/edge.ts`, `packages/cli/test/edge.test.ts` | `packages/cli/src/index.ts` |
| Cognit-5vl.8 | 3b: sticky current-session + global --json + cognit events | Cognit-5vl.1 | `packages/cli/src/paths.ts`, `packages/cli/src/output.ts`, `packages/cli/src/current-session.ts`, `packages/cli/src/commands/events.ts`, `packages/cli/test/{sticky-session,json-output,schema-dump,events}.test.ts` | `packages/cli/src/index.ts`, `packages/cli/src/commands/{session,append,inbox,observation,finding,hypothesis,theory,experiment,decision,conclusion,verification,artifact,edge}.ts` |
| Cognit-5vl.9 | 3c: constraint engine (closed v1 set of 13 predicates, eval hook, CLI) | Cognit-5vl.1 | `packages/core/src/constraint-dsl.ts`, `packages/core/test/constraint-dsl.test.ts`, `packages/db/src/constraint-engine.ts`, `packages/db/test/{constraint-engine,event-store-constraint}.test.ts`, `packages/cli/src/commands/constraint.ts`, `packages/cli/test/constraint.test.ts` | `packages/db/src/session-service.ts` (call engine in `appendEvent`; update `MAP_FIELDS` in `rehydrateSessionState`), `packages/core/src/reducer.ts` (add `applied_rule_ids: Set<string>`), `packages/db/src/errors.ts` (add `ConstraintViolation`), `packages/db/src/layers/live.ts` (provide `ConstraintPolicy` Context.Tag), `packages/cli/src/index.ts` |
| Cognit-5vl.10 | 3d: Hono server in apps/server | Cognit-5vl.9 | `apps/server/src/index.ts`, `apps/server/src/routes/{sessions,events,state,healthz}.ts`, `apps/server/src/bus.ts`, `apps/server/src/auth.ts`, `apps/server/src/sse.ts`, `apps/server/src/layer-build.ts`, `apps/server/test/{healthz,sessions-routes,sse-bus,post-events-redaction,auth-bearer}.test.ts`, `packages/core/src/view.ts` | `packages/db/src/inbox.ts`, `packages/db/src/event-store.ts` (return `EventRow` to caller, no signature change), `packages/core/src/reducer.ts` (export `project(state) -> SessionStateView`), `apps/server/package.json`, `turbo.json` |
| Cognit-5vl.11 | phase-3 E2E + cleanup (acceptance, test counts, docs) | Cognit-5vl.10 | `packages/cli/test/phase-3.e2e.test.ts`, `apps/server/test/phase-3.server.e2e.test.ts` | `STACK.md`, `README.md` |

## Dependency graph (rev. 1 — simplified)

```
5vl.1 (3a-1) ──┬─ 5vl.2 (3a-2)
               ├─ 5vl.3 (3a-3)
               ├─ 5vl.4 (3a-4)
               ├─ 5vl.5 (3a-5)
               ├─ 5vl.6 (3a-6)
               ├─ 5vl.7 (3a-7)
               ├─ 5vl.8 (3b)      ← includes cognit events
               └─ 5vl.9 (3c) ◄────── 5vl.1 only (was 5vl.1+5vl.3)
                        │
                        └─ 5vl.10 (3d) ◄──── 5vl.9 only (was 5vl.1+5vl.9)
                                  │
                                  └─ 5vl.11 (E2E + cleanup)
```

Critical path: 5vl.1 → 5vl.9 → 5vl.10 → 5vl.11 (4 deep).
Parallelism: 5vl.2..8 all block only on 5vl.1 → fan out 6 agents concurrently.

## Changes from rev. 0 (post plan-review)

1. **3c dep on 3a-3 dropped.** The constraint engine evaluates
   predicates against `state` and `candidateEvent` (a generic typed
   payload). It needs the `CognitionService` Context.Tag shape from
   3a-1, not the per-entity methods from 3a-3.
2. **3d dep on 3a-1 dropped.** 3d's read path uses
   `SessionService.show` + a new `project(state) -> SessionStateView`
   in `packages/core/src/view.ts`. No `CognitionService` method is
   required. 3d still depends on 3c because `DbLive` now provides
   `ConstraintPolicy` (a Context.Tag), and the server's
   `apps/server/src/layer-build.ts` must compose it.
3. **3a-6 expanded**: `conclusion` + `verification` + `artifact
   add` + `verify cancel` (the `cancelVerification` method from
   the master plan `CognitionService` list, plus the `artifact
   add` from `plan.xml:422`).
4. **3a-7 expanded**: `edge add` + `edge list` (read-only dump of
   `state.edges`, separate command file but same package).
5. **3b expanded**: now also owns the `cognit events [--follow]`
   command (bootstrap success criterion `plan.xml:841`).
   `events.ts` is a new command; it shares the JSON envelope from 3b.
6. **3c chokepoint clarified**: hook lives in
   `SessionService.appendEvent` (NOT `EventStore.append`). The
   `MAP_FIELDS` set in `rehydrateSessionState` (session-service.ts
   near line 276-284 per review) is updated to include the new
   `applied_rule_ids` field on `SessionState`.
7. **Predicate vocabulary extended from 10 to 13** to express the
   realistic lifecycle rules (hypothesis-must-be-active-to-promote,
   decision-requires-verified-conclusion, multi-event conditions).
   The "closed v1" decision is preserved; only the size grew.

## Execution plan (PHASE 1 → PHASE 2 → PHASE 3)

1. **PHASE 1 — Scaffold** (no breaking changes; new types/files only):
   - 3a-1 first: CognitionService Context.Tag shell + observation CLI + 1 happy-path test. Validates the shape.
2. **PHASE 2 — Migrate** (1 module = 1 agent = 1 cycle; test after each):
   - 3a-2..3a-7 + 3b fan out in parallel (6 agents, all blocked only on 3a-1)
   - 3c lands after 3a-1 (independent of 3a-3/4/5/6/7)
   - 3d lands last; depends on 3c only
3. **PHASE 3 — Cleanup**:
   - 5vl.11: E2E tests, test-count target verification, STACK.md/README update, quality gate.

## Test count target

- 130+ db / 60+ cli / 50+ core / 10+ server
- vs. phase 2.5 baseline: 103 / 37 / 44 / 0
- delta: +27 db / +23 cli / +6 core / +10 server

## Risks (carry-over from master plan §Risks)

- **3a subtask count** — 7 new CLI files plus CognitionService. Mitigation: 3a-1 first (CognitionService + observation only); per-entity follow-ups each behind their own quality gate.
- **3c coupling to reducer** — constraint hook is in `SessionService.appendEvent` (not `EventStore.append`); structurally identical to phase 2.5 auto-snapshot helper, sits between `SessionClosed` pre-check and snapshot post-step. Mitigation: don't refactor speculatively; ship a `ConstraintPolicy` Context.Tag built once at CLI/server boot.
- **3d SSE in-process** — bus is per-`cognit server` process. Mitigation: document as v0.1 limitation; multi-process fanout = inbox file IPC.
- **3d POST /events parallel write path** — route funnels through `SessionService.appendEvent`. Mitigation: route-level test asserts redaction boundary still enforced.
- **3b JSON contract** — once an external tool depends on `--json`, the envelope is public. Mitigation: pin `version: 1`; ship `cognit schema-dump`; require major bump for breaking changes.

## Decision log (KG)

- Phase 3 → port_api → 127.0.0.1:6971
- Phase 3 → port_ui_future → 6970
- Phase 3 constraint → predicate_vocabulary → closed v1 set of 13 predicates; new predicates = core schema version bump
- Phase 3 sticky session → race_strategy → atomic rename + LWW + 24h mtime warn; --session flag wins
- Phase 3 server auth → auth_policy → opt-in bearer; off on loopback; activates when api_token set AND non-loopback bind
- Phase 3 first slice → first_slice → 3a-1: CognitionService shell + observation CLI (text only, no state machine)
