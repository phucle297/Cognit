# D-M1-00 — Golden replay fixtures (ES safety net)

**Milestone:** M1 (first — before redaction / snapshot work)  
**Effort:** S–M  
**Breaking:** No  
**Blocks:** D-M1-02, D-M1-03 (soft-hard: required before merging snapshot PRs)

---

## Problem

Cognit is an event-sourced system. Reviewer unit tests cover many reducer branches, but there is **no frozen corpus** of:

```text
recorded event log  →  pure reduce  →  expected SessionState
```

Without golden replay:

- Snapshot I/O refactors can pass local tests and still drift entity state.
- SessionState shape changes can go unnoticed.
- “Deterministic replay” is asserted piecemeal, not as a product contract.

This is **architecture hygiene**, not a feature. Capture signals do not replace it.

## Current implementation

- Strong unit tests in `packages/core/test/reducer.test.ts` (synthetic events).
- Integration tests build sessions live via CLI/DB.
- **No** checked-in `fixtures/session-*/events.jsonl` + `expected-state.json` replay gate.

## Alternatives considered

| Option | Pros | Cons |
|--------|------|------|
| A. Rely on existing unit tests only | Zero new work | No frozen multi-event corpus; weak for snapshot PRs |
| B. **Golden fixtures + compare** | Standard ES practice; CI-stable | Must curate fixtures carefully |
| C. Full DB dump replay only | Realistic | Couples to SQLite packaging; harder pure-core gate |

## Chosen solution

**B — pure-core golden replay**, optional DB layer later.

### Layout

```text
packages/core/fixtures/golden/
  session-v1/
    meta.json              # schema/fixture version, description
    events.jsonl           # one ReducerEvent JSON per line, replay order
    expected-state.json    # canonical SessionState (Maps → objects)
  session-v1-decisions/    # second fixture (lifecycle edge cases)
    ...
  README.md                # how to regenerate; when to add fixtures
```

### Runner

- Test file: `packages/core/test/golden-replay.test.ts`
- For each fixture directory:
  1. Load `events.jsonl` → `ReducerEvent[]`
  2. `reduce(events)` (or empty initial + events)
  3. Serialize state with **same deterministic rules** as snapshot writer will use (shared `serializeSessionState` in `core` or test helper that matches db serialization for Maps)
  4. Deep-compare to `expected-state.json`
  5. On failure: print path + JSON diff (minimal)

### CI policy (binding)

| Change set | Required |
|------------|----------|
| Any file under `packages/core/src/reducer.ts`, `state.ts`, `event-types.ts` | Golden suite must pass |
| D-M1-02 / D-M1-03 snapshot PRs | Golden suite must pass; add fixture if new lifecycle path |
| Unrelated CLI docs | No new obligation beyond normal `pnpm test` |

Wire into existing `pnpm --filter @cognit/core test` (no separate flaky job).

### Regenerating goldens

- Script or vitest `--update` only for maintainers when intentional state shape change.
- Document: never regenerate to “make CI green” without design note in PR.
- Fixture `meta.json` includes `fixture_format: 1` and human `intent`.

### What goldens assert

**In scope:** entity maps, lifecycle pointers (`current_*`), observations/findings arrays, edges, status, goal, last_event_*.

**Timeline:** either  
(1) include full timeline in expected (brittle, O(n)), or  
(2) **strip timeline before compare** and assert `last_event_id` only.

**Recommendation:** strip timeline for compare (aligns with D-M1-02 slim snapshots). Document clearly.

### Minimum fixture set for M1-00

1. `session-v1` — observation → decision propose → accept → verification → conclusion  
2. `session-v1-reject` — decision reject + conclusion reject path  
3. Optional: hypothesis weaken/promote if still in public internal surface  

Keep fixtures **small** (tens of events), not millions.

## Migration strategy

- Additive tests only.
- No DB migration.
- No production behavior change.

## Risk

| Risk | Mitigation |
|------|------------|
| Brittle timestamps/UUIDs | Fixtures use fixed ULID + fixed `created_at` strings |
| Map serialization mismatch core vs db | Share one serialize helper or dual-assert db rehydrate in a later PR |
| Maintainers regenerate blindly | PR template note + meta.intent required |

## Rollback strategy

- Delete fixtures + test file; no runtime impact.

## Tests required

- Golden suite itself is the test.
- One intentional mutation test: tweak an event type → expect failure (proves gate is live).

## Implementation notes (for later PR — not now)

- Prefer pure JSON, no SQLite dependency in `packages/core`.
- Do not block M0 on this; land as **first M1 PR**.
- D-M1-03/02 must not merge without green goldens.
