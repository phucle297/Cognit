# Phase 8 — Gravity & Constraint Engines

**Date:** 2026-06-19
**Source spec:** `plan.xml:802-809` (phase 8) + `plan.xml:543-557` (gravity_engine) + `plan.xml:559-619` (constraint_engine)
**Prefix:** `8g` (phase 8 gravity)
**Parent epic:** `Cognit-8g`
**Sub-beads:** `Cognit-8g.0` … `Cognit-8g.6` (7 total)

## Goal

Ship the v0.2 gravity ranking + constraint-driven hypothesis mutation end-to-end:

1. **Gravity Engine** — weighted-sum hypothesis ranking → fills `suggested_next_steps` (currently hard-coded `[]` in `packages/recovery/src/recovery.ts:189`; rendered as placeholder card in `apps/dashboard/src/pages/recovery-center.tsx:673`).
2. **Constraint Engine v2** — extends the existing phase-3c block-only engine with 4 new mutation actions (`reject_hypothesis`, `weaken_hypothesis`, `promote_hypothesis`, `create_finding`), fired post-append on `experiment_completed` and `verification_failed` events.
3. Rules configurable via `cognit.yaml` + DB override; CLI to add/list/disable rules; dashboard Rules page.
4. CLI `cognit session resume` prints the top suggested step.
5. Loop guard via `(event_id, rule_id, action_type)` dedup table.

**Done_when:** One experiment can weaken/reject/promote related hypotheses via a rule, and `cognit session resume` prints the highest-gravity active hypothesis.

## Current state (audit, 2026-06-19)

| File | Role | Gap |
|---|---|---|
| `packages/core/src/constraint-dsl.ts:1-204` | Phase-3c DSL: 13 typed predicates + 1 action (`block`) | need 4 mutation actions |
| `packages/db/src/constraint-engine.ts` | Pure evaluator, returns `ConstraintViolation` | need post-append transformer + audit dedup |
| `packages/db/src/constraint-policy.ts:108` | Loads rules from `constraint_rule_added` events; "v1 supports only 'block'" | load action types properly |
| `packages/db/src/event-store.ts:88-119` | `INSERT INTO actors` with `trust_score` default 0 (sentinel) | trust_score column ready, no gravity consumer yet |
| `packages/db/src/cognition-service.ts:51` | `HypothesisRejectReasonType = "evidence" \| "superseded" \| "constraint"` | `constraint` reason type pre-wired |
| `packages/recovery/src/recovery.ts:84,189` | `suggested_next_steps: ReadonlyArray<unknown>` = `[]` | needs gravity-ranked array of `{id, text, score}` |
| `apps/cli/src/commands/recovery.ts:145-149` | Prints `suggested_next_steps (N):` header | prints count only — needs id + text |
| `apps/cli/src/commands/session.ts:370-414` | `cognit session resume` — no suggested step line | add `Suggested next step:` output |
| `apps/dashboard/src/pages/recovery-center.tsx:673-692` | `SuggestedNextStepsCard` placeholder | needs real list (id + text + score) |
| `apps/cli/src/commands/constraint.ts` | Existing CLI for `block`-only rules | extend with add/list/disable |
| `apps/server/src/routes/events.ts:289-290` | `ConstraintViolation` → 422 `constraint_violation` | unchanged |
| `packages/core/src/config.ts:69` | `trust_score: TrustScore` already typed | reads in gravity consumer |

**Test rot check:** 0 open issues; pre-phase baseline is phase-7's 601/601 passing + 1 pre-existing flake (CLI phase-3 e2e warm-path timing).

## Risks (impact)

| Impact | Risk | Mitigation |
|---|---|---|
| HIGH | Constraint engine infinite loops (rule rejects hypothesis → emits `hypothesis_rejected` → re-triggers) | `(event_id, rule_id, action_type)` dedup table + skip constraint-emitted events by default |
| HIGH | Gravity formula overweights single signal (e.g. one big reproducibility score dominates) | Configurable weights in `cognit.yaml` `gravity.weights.*`, default sum=1.0; per-project override |
| HIGH | Freshness decay makes fresh-but-unverified hypotheses disappear too fast | Configurable half-life `gravity.freshness_half_life_days`, default 14 (per user choice) |
| HIGH | New actions emit events that mutate hypothesis/decision/finding counts — breaks downstream counts | Each action emits ONE canonical event; reducer handles all derived state; integration tests assert state consistency |
| MED | v1 DSL (`Predicate` union, 13 typed predicates) doesn't match plan.xml `condition_dsl` (`all`/`any`/`not` + `$h` binding) | Ship v2 actions on existing v1 predicate DSL; defer full `condition_dsl` rewrite to v2.x; flag in plan.md "deferred" section |
| MED | `actor.trust_score` of contributing events needs Effect join across events | Add `contributingActors(hypothesisId)` selector in `packages/db/src/gravity.ts` |
| MED | Bundle growth: dashboard Rules page (CRUD UI) | Code-split Rules route via React.lazy; re-run `test:budget` cap (216,300 / 256,000 = 39.7 KB headroom) |
| MED | New dep: `node-cron`-style scheduler NOT needed (event-driven) — but may need `decimal.js` for normalized weights | No new dep unless proven; use Effect `Number` arithmetic |
| LOW | Rule ordering / priority (multiple rules fire — order of audit events) | Stable sort by `(rule_id, action_type)`; deterministic |
| LOW | Migration: add `gravity_fired_at` column on hypotheses for freshness | Yes — single ALTER TABLE in `8g.1`; tracked as "one migration, additive" (forbidden-list exception: explicit approval per orchestrator rules) |

**Migration decision:** Phase 8 needs ONE additive column (`hypotheses.gravity_fired_at REAL`) for freshness decay to be per-hypothesis monotonic. Flagging as exception — needs explicit user approval before `8g.1`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         WRITE PATH (existing)                       │
│ POST /api/events → redaction → appendEvent → reducer → state       │
│                                       │                             │
│                          ┌────────────┴─────────────┐               │
│                          │ ConstraintPolicy.eval    │ ← v1 block    │
│                          │   .evalBlockRules        │   (3c, kept)  │
│                          └────────────┬─────────────┘               │
│                                       │ if pass                    │
└───────────────────────────────────────┼─────────────────────────────┘
                                        │
┌───────────────────────────────────────▼─────────────────────────────┐
│                     POST-APPEND TRANSFORMER (new)                   │
│   on event.type ∈ {experiment_completed, verification_failed}:      │
│     1. Compute triggering hypothesis ID (or $h from event.payload)  │
│     2. For each enabled rule matching event:                        │
│          if (event_id, rule_id, action_type) NOT in dedup:          │
│            apply action → emit ONE canonical event                  │
│            record (event_id, rule_id, action_type) in dedup         │
│     3. Skip events emitted by constraint engine itself              │
└─────────────────────────────────────────────────────────────────────┘
                                        │
┌───────────────────────────────────────▼─────────────────────────────┐
│                       READ PATH (new)                               │
│ GET /api/sessions/:id/gravity →                                    │
│   packages/gravity/scoreHypothesis(state, hypothesisId, cfg) →     │
│     evidence_strength + reproducibility + verification_confidence  │
│     + actor_trust (decayed) + freshness × weights                  │
│   rank all active hypotheses → top-N                               │
│                                                                     │
│ GET /api/sessions/:id/recovery (extended) →                        │
│   packages/recovery/RecoveryRecord:                                │
│     suggested_next_steps = top-1 active hypothesis                 │
│     { id, text, score }                                            │
└─────────────────────────────────────────────────────────────────────┘
```

## Sub-beads

| # | Subject | Est | Depends | ACs |
|---|---|---|---|---|
| `8g.0` | Spec lock + audit: weights, decay fn, dedup schema, migration sign-off | S (2h) | — | spec doc + user sign-off on weights/half-life/migration |
| `8g.1` | Extract `@cognit/gravity` pkg + `hypotheses.gravity_fired_at` migration + scoring fn | L (8h) | `8g.0` | 8.1, 8.2, 8.3, 8.4, 8.5 |
| `8g.2` | Extend `@cognit/core/constraint-dsl` with 4 mutation actions | M (6h) | `8g.0` | 8.6, 8.7 |
| `8g.3` | Wire post-append transformer + `(event_id, rule_id, action_type)` dedup + skip-constraint-emitted | L (8h) | `8g.2` | 8.8, 8.9, 8.10, 8.11 |
| `8g.4` | Server `GET /api/sessions/:id/gravity` + fill `suggested_next_steps` + CLI resume prints it | M (6h) | `8g.1`, `8g.3` | 8.12, 8.13, 8.14 |
| `8g.5` | Dashboard: real `SuggestedNextStepsCard` + Constraint Rules page (CRUD) | L (8h) | `8g.2`, `8g.4` | 8.15, 8.16 |
| `8g.6` | Polish + verification + `docs/phase-8-results.md` | S (3h) | `8g.1`–`8g.5` | full suite green + bundle cap |

**Total est:** 41h, MEDIUM→LARGE per orchestrator scoring.

## Acceptance criteria (16, all testable)

### Gravity scoring
- **AC-8.1** `scoreHypothesis(h, cfg)` returns a real number in `[0, 1]`; deterministic for `(state, cfg)` tuple.
- **AC-8.2** Inputs: `evidence_strength` (count supporting findings/conclusions), `reproducibility` (passed verifications × recency), `verification_confidence` (latest exit signal), `actor_trust` (weighted `actor.trust_score` of contributing events), `freshness` (decay from `gravity_fired_at`).
- **AC-8.3** Freshness half-life from `cognit.yaml` `gravity.freshness_half_life_days`, default 14; function = `0.5 ** (age_days / half_life)`.
- **AC-8.4** Weights from `cognit.yaml` `gravity.weights.*`, default `{evidence: 0.30, reproducibility: 0.30, confidence: 0.20, trust: 0.10, freshness: 0.10}`; sum validated to ≈1.0 on load.
- **AC-8.5** Hypotheses with `state ≠ active` excluded from ranking; ranking stable-sorted by `(score desc, hypothesis_id asc)`.

### Constraint engine v2
- **AC-8.6** `RejectHypothesisAction`, `WeakenHypothesisAction`, `PromoteHypothesisAction`, `CreateFindingAction` added to Action union in `packages/core/src/constraint-dsl.ts`.
- **AC-8.7** v1 `BlockAction` preserved; new actions validate via Effect Schema on rule add.
- **AC-8.8** Post-append transformer fires on `experiment_completed` and `verification_failed` ONLY.
- **AC-8.9** Dedup table: `(event_id, rule_id, action_type)` triple; second pass skips.
- **AC-8.10** Events emitted by constraint engine (4 action types) marked `__constraint_emitted: true` in payload; transformer skips them by default.
- **AC-8.11** Each fired action emits exactly ONE canonical event with `actor_id = "system:constraint-engine"` + `payload.rule_id` + `payload.cause_event_id`; reducer applies mutation deterministically.

### Server + CLI + Dashboard
- **AC-8.12** `GET /api/sessions/:id/gravity` returns ranked active hypotheses with score, breaking ties by id; endpoint read-only (50 calls → no event mutation).
- **AC-8.13** Recovery surface: `suggested_next_steps` = top-1 active hypothesis `{id, text, score}`; empty if no active hypotheses (NOT `[]` placeholder).
- **AC-8.14** CLI `cognit session resume` prints `Suggested next step: <text>  (gravity: <score>, id: <id>)` line when present.
- **AC-8.15** Dashboard `SuggestedNextStepsCard` renders id + text + score; empty state when no active hypotheses.
- **AC-8.16** Dashboard Constraint Rules page: list, add (paste JSON / form), enable/disable, delete; reads from `cognit.yaml` + DB override; bundle stays ≤256,000 bytes gzip.

## Cross-cutting constraints

- **One additive migration** — `hypotheses.gravity_fired_at REAL DEFAULT 0`. Explicit user sign-off required (forbidden-list exception per orchestrator rules).
- **No new dep.** Use Effect `Number` arithmetic; no `decimal.js` unless proven necessary.
- **v1 DSL stays.** Don't rewrite to plan.xml `condition_dsl` — extend Action union. Document the design-target `condition_dsl` as deferred in `docs/phase-8-results.md`.
- **Read-only gravity endpoint.** Like recovery — no mutation, 50-call audit test.
- **Loop guard mandatory.** AC-8.9 + AC-8.10 are P0; quality gate fails if missing.
- **Update, don't delete** `packages/recovery/src/__tests__/recovery.test.ts:69` placeholder lock → becomes real-shape lock.

## Dependency graph

```
8g.0 (spec lock + migration sign-off)
  ├── 8g.1 (@cognit/gravity pkg + migration + scoring fn)
  │      └── 8g.4 (server gravity route + recovery fill + CLI resume)
  └── 8g.2 (extend constraint-dsl Action union)
         └── 8g.3 (post-append transformer + dedup + skip-constraint-emitted)
                └── 8g.4 (server gravity route + recovery fill + CLI resume)
                       └── 8g.5 (dashboard suggested card + rules page)
                              └── 8g.6 (polish + verification + results doc)
```

## Commit message format

```
feat: Cognit-8g.<N> <subject>
fix: Cognit-8g.<N> <subject>
chore: Cognit-8g.<N> <subject>
```

## Out of scope (defer)

- Full `condition_dsl` rewrite (`all`/`any`/`not` + `$h` binding) — v2.x; v0.2 ships on extended v1 predicate DSL.
- Learned gravity weights (per-domain ML) — v2.x.
- Rule UI for composing predicates via form (only JSON paste + validate).
- Cross-session gravity (per-project vs per-session).
- Per-actor trust history / override UI.
- Constraint engine actions beyond 4 (no `tag`, `redact`, `merge_hypothesis`).
- Real-time dashboard SSE update on gravity rank change (polling on session open is enough).

## Open decisions — RESOLVED 2026-06-19

1. **Migration sign-off** — **APPROVED.** User explicitly approves the single additive column `hypotheses.gravity_fired_at REAL DEFAULT 0`. Recorded as orchestrator-rules forbidden-list exception per bead Cognit-8g.0 acceptance criteria. To be executed in `8g.1` (single `ALTER TABLE`, idempotent). Source: bead description §migration + user request to ship phase 8.
2. **DSL strategy** — **CONFIRMED.** Extend v1 typed-predicate DSL with 4 new actions (`reject_hypothesis`, `weaken_hypothesis`, `promote_hypothesis`, `create_finding`); do NOT rewrite to plan.xml `condition_dsl` (`all`/`any`/`not` + `$h` binding). The full `condition_dsl` rewrite is deferred to v2.x and flagged in `docs/phase-8-results.md` "deferred" section. Source: plan §Cross-cutting constraints "v1 DSL stays" + AC-8.6, AC-8.7.
3. **Default weights** — **CONFIRMED.** `{evidence: 0.30, reproducibility: 0.30, confidence: 0.20, trust: 0.10, freshness: 0.10}` (sum = 1.00, validated within ±0.001 on load). Configurable per project via `cognit.yaml` `gravity.weights.*`. Source: AC-8.4 + bead description §weights.
4. **Default half-life** — **CONFIRMED.** 14 days, configurable per project via `cognit.yaml` `gravity.freshness_half_life_days`. Function: `freshness = 0.5 ** (age_days / half_life)`. Source: AC-8.3 + bead description §half-life.
5. **Loop guard** — **CONFIRMED.** Two-part guard: (a) `(event_id, rule_id, action_type)` dedup table — second pass for the same triple is skipped; (b) events emitted by the constraint engine itself (4 action types) carry `__constraint_emitted: true` in payload and are skipped by default by the post-append transformer. Source: AC-8.9, AC-8.10, AC-8.11 + plan §Risks HIGH row 1.
6. **Rules storage** — **CONFIRMED.** `cognit.yaml` is the base; DB override (`constraint_rule_added` events) wins on conflict. CLI `cognit constraint` add/list/disable reads both layers; dashboard Rules page reads both. Source: plan §Goal item 3 + AC-8.16.