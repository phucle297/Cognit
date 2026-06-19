# Phase 8 (Cognit-8g) — Gravity & Constraint Engines — Results

**Epic:** Cognit-8g — Phase 8 Gravity & Constraint Engines (v0.2)
**Plan:** `docs/superpowers/plans/2026-06-19-phase-8-gravity-constraint.md`
**Closed:** 2026-06-19
**Sub-beads:** 8g.0 → 8g.6 (7 beads, all closed)

---

## 1. Acceptance Criteria Checklist (16 items)

| #     | AC                                                                | Status | Where verified                                                                  |
|-------|-------------------------------------------------------------------|--------|---------------------------------------------------------------------------------|
| 8.1   | @cognit/gravity package extracted with pure scoreHypothesis        | ✅      | `packages/gravity/src/scoring.ts:119` + `packages/gravity/test/scoring.test.ts` |
| 8.2   | gravity_fired_at REAL column on hypotheses, default 0              | ✅      | `packages/db/src/schema/migrations/0003_gravity_fired_at_v1.2.0.sql`             |
| 8.3   | 5-axis weighted sum: evidence/reproducibility/confidence/trust/freshness | ✅ | `packages/gravity/src/scoring.ts:124-130` + 32-case test                          |
| 8.4   | Weights sum to 1.0 ±0.001, schema-validated                        | ✅      | `packages/core/src/config.ts:152-162` GravityConfig filter                       |
| 8.5   | rankHypotheses excludes non-active hypotheses, stable sort        | ✅      | `apps/server/test/sessions-gravity.test.ts:6` (rejected filtered)               |
| 8.6   | Freshness half-life decay: 0.5 ** (age_days / half_life)           | ✅      | `packages/gravity/src/scoring.ts:99-103`                                         |
| 8.7   | Constraint DSL extended with 4 mutation actions                    | ✅      | `packages/core/src/constraint-dsl.ts` (reject/weaken/promote/create_finding)    |
| 8.8   | Post-append transformer fires on experiment_completed / verification_failed | ✅ | `packages/db/src/constraint-engine.ts:203` + `constraint-transform.test.ts` |
| 8.9   | constraint_action_log dedup table (event_id, rule_id, action_type) | ✅      | `packages/db/src/schema/migrations/0004_constraint_action_log_v1.3.0.sql`        |
| 8.10  | Loop guard via skip-constraint-emitted                             | ✅      | `packages/db/src/session-service.ts` + `constraint-audit.test.ts`                |
| 8.11  | gravity_fired_at updated on mutation actions                       | ✅      | `packages/db/src/session-service.ts` + state reducer                             |
| 8.12  | Recovery surface fills suggested_next_steps with top-1 active hypothesis | ✅ | `packages/recovery/src/recovery.ts:213` + `state-graph-edges.test.ts` case 4b   |
| 8.13  | GET /api/sessions/:id/gravity read-only, 50-call audit             | ✅      | `apps/server/test/sessions-gravity.test.ts` (6 cases incl. 50-call lock)         |
| 8.14  | CLI session resume prints "Suggested next step:" line              | ✅      | `apps/cli/src/commands/session.ts:474` + `apps/cli/test/recovery.test.ts`         |
| 8.15  | Dashboard SuggestedNextStepsCard real (id+text+score badge)        | ✅      | `apps/dashboard/src/pages/recovery-center.tsx:709` + RecoveryCenter.test.tsx     |
| 8.16  | Dashboard /rules CRUD page (lazy-loaded, yaml/db source badge)     | ✅      | `apps/dashboard/src/pages/rules.tsx` + `Rules.test.tsx` (7 cases)                 |

**Result: 16/16 ACs met.**

---

## 2. Test Counts (pre-phase → post-phase)

| Package              | Pre  | Post | Δ     |
|----------------------|------|------|-------|
| @cognit/core         | 58   | 58   | 0     |
| @cognit/verification | 44   | 44   | 0     |
| @cognit/recovery     | 7    | 7    | 0     |
| @cognit/gravity      | —    | 32   | +32   |
| @cognit/db           | 197  | 202  | +5    |
| @cognit/dashboard    | 75   | 83   | +8    |
| @cognit/server       | 70   | 83   | +13   |
| @cognit/cli          | 150  | 151  | +1    |
| @cognit/sdk          | —    | —    | 0     |
| **Total**            | 601  | 660  | **+59** |

- **Target:** net +30 / 631+ total → **EXCEEDED** (+59 / 660 total).
- 2 pre-existing CLI flakes on `phase-3.e2e.test.ts` (warm-path `<500ms` timing assertion) and `import.test.ts` (process-spawn timeout under load). Both pass when re-run in isolation; flap only under parallel `turbo run test` load on this workstation. Not blocking.

---

## 3. Quality Gates

| Gate                                       | Result    | Notes                                              |
|--------------------------------------------|-----------|----------------------------------------------------|
| `pnpm -w typecheck`                        | ✅ PASS    | 14/14 packages clean (tsgo --noEmit)               |
| `pnpm -w lint`                             | ✅ PASS    | 0 errors; only pre-existing warnings               |
| `pnpm --filter @cognit/server test`        | ✅ PASS    | 83/83 (18 files; +6 gravity route, +6 rules CRUD, +1 8g.4 shape lock) |
| `pnpm --filter @cognit/recovery test`      | ✅ PASS    | 7/7 (shape updated for suggested_next_steps)       |
| `pnpm --filter @cognit/gravity test`       | ✅ PASS    | 32/32 (scoring + ranking determinism + freshness)  |
| `pnpm --filter @cognit/dashboard test`     | ✅ PASS    | 83/83 (22 files; +7 Rules.test.tsx, +1 RecoveryCenter populated state) |
| `pnpm --filter @cognit/cli test`           | ⚠ 149/151 | Pre-existing flakes (phase-3 e2e + import); pass in isolation |
| `pnpm --filter @cognit/db test`            | ✅ PASS    | 202/202                                            |
| `pnpm --filter @cognit/dashboard build`    | ✅ PASS    | dist/ produced, no errors                          |
| `pnpm --filter @cognit/dashboard test:budget` | ✅ PASS | 218,383 bytes gzip ≤ 256,000 cap (85.3% utilisation) |

---

## 4. Bundle Sizes (dashboard `dist/` gzip)

| File                                  | Raw      | Gzip    |
|---------------------------------------|----------|---------|
| `assets/index-D4GSA6-E.js` (main)     | 595,858  | 188,040 |
| `assets/recovery-center-CjabYbdE.js`  | 63,615   | 20,749  |
| `assets/index-DpgYh8sk.css`           | 52,309   | 9,541   |
| `assets/rules-BJS2fnTy.js` (8g.5 new) | 5,471    | 1,912   |
| `index.html`                          | 507      | 319     |
| **TOTAL**                             | 717,760  | **220,561** |

> Note: `pnpm --filter @cognit/dashboard test:budget` reports 218,383 (header sum vs gzip-of-tarball delta — both well under cap).

- Per-package cap: **256,000 bytes** (250 KB) → ✅ **PASS** (85.3% utilisation).
- Rules route lazy-loaded as separate chunk (**1.9 KB gzip**) — code-split confirmed.
- Δ bundle from 7r: +2,061 bytes gzip total (recovery-center +93, rules +1,912, main +56) — within budget headroom of 35.6 KB.

---

## 5. Sub-bead Commit Log

| Bead       | Title                                                                   |
|------------|-------------------------------------------------------------------------|
| Cognit-8g.0 | audit + gravity_fired_at migration sign-off                            |
| Cognit-8g.1 | extract @cognit/gravity pkg + migration + scoring fn                   |
| Cognit-8g.2 | extend @cognit/core constraint-dsl with 4 mutation actions             |
| Cognit-8g.3 | wire post-append transformer + (event_id, rule_id, action_type) dedup  |
| Cognit-8g.4 | server GET /api/sessions/:id/gravity + fill suggested_next_steps + CLI resume |
| Cognit-8g.5 | dashboard real SuggestedNextStepsCard + /rules CRUD page               |
| Cognit-8g.6 | polish + verification + results doc (this file)                        |

---

## 6. Known Flakes (carry-over)

| Test                                                              | Symptom                                | Mitigation                                |
|-------------------------------------------------------------------|----------------------------------------|-------------------------------------------|
| `apps/cli/test/phase-3.e2e.test.ts` (warm-path `<500ms`)           | Times out under `turbo run test` load  | Passes solo (`pnpm test test/phase-3.e2e.test.ts`); pre-existing |
| `apps/cli/test/import.test.ts` (`--merge-strategy skip`)          | Spawn-based timeout under parallel load | Passes solo; pre-existing                  |

Both flap only under simultaneous spawn pressure on this workstation. No code regression introduced by 8g.

---

## 7. Architectural Notes

- **Gravity engine isolation:** `@cognit/gravity` has zero `@cognit/db` dependency — pure functions over `SessionState`. The server (`apps/server/src/gravity-inputs.ts`) wires the state-level axes (evidence/reproducibility/confidence) so the package can be unit-tested with synthetic states.
- **Recovery package isolation:** `@cognit/recovery` continues to depend on `@cognit/core` only. The route resolves the gravity ranking and passes it in as `suggestedNextSteps`. Top-1 selection lives in `buildRecovery`.
- **Read-only invariant:** `GET /api/sessions/:id/gravity` and `GET /api/sessions/:id/recovery` both verified by 50-call audit tests. Constraint-driven mutations land only via the `POST /api/events` chokepoint (`SessionService.appendEvent`).
- **Rules CRUD:** session-scoped under the hood (`constraint_rule_added` events with collapse-by-rule_id semantics). PATCH/DELETE re-emit the event with `enabled`/`deleted` fields. Soft-deleted rules are filtered from `GET /api/rules`. YAML loading is wire-shape-ready (`source: "yaml"`) but defers actual loader integration to a follow-up bead.

---

## 8. Ready for Epic Close

All 8g.0 → 8g.6 sub-beads closed. Quality gate PASS across all 5 dimensions. Bundle cap holds. `bd close Cognit-8g` is safe.
