# Phase 7 — Recovery Engine

**Date:** 2026-06-19
**Source spec:** `plan.xml:793-801` (phase 7) + `plan.xml:522-541` (recovery semantics)
**Prefix:** `7r` (phase 7 recovery)
**Parent epic:** `Cognit-7r`
**Sub-beads:** `Cognit-7r.0` … `Cognit-7r.6` (7 total)
**Pre-approved deps:** `fuse.js` (named in `STACK.md` §stack + `plan.xml:393,524,796` — no new-approval round)

## Goal

Ship the full v0.2 recovery surface end-to-end:

1. `GET /api/sessions/:id/recovery` returns 8 top-level fields (vs current 3-field v0.1 contract).
2. Fuzzy keyword search over goals/findings/hypotheses/decisions/conclusions with filters.
3. CLI: `cognit recovery` subcommand + `cognit session resume --search`.
4. Dashboard Recovery Center renders all 8 fields + search input.
5. Remove the 3 dashboard dry-run/snapshot/export UI stubs (real POST endpoints).

## Current state (audit, 2026-06-19)

| File | Role | Gap |
|---|---|---|
| `apps/server/src/routes/sessions.ts:247-310` | v0.1 recovery handler (3 fields) | needs 8 fields |
| `apps/server/test/state-graph-edges.test.ts:259` | locks v0.1 key set | must UPDATE to v0.2 |
| `apps/dashboard/src/pages/recovery-center.tsx:1-396` | renders 3 sections + 3 stub buttons | needs 8 sections + search + real buttons |
| `apps/dashboard/src/pages/recovery-center.tsx:336-348` | POSTs to non-existent routes | need server endpoints |
| `apps/cli/src/commands/session.ts:370-414` | `cognit session resume` — no recovery block | need recovery output |
| `apps/cli/src/index.ts:57-80` | command registry — no `registerRecovery` | need new subcommand |
| `packages/verification/src/index.ts:1-127` | subprocess pipeline | not the home for recovery |
| `packages/db/src/schema/tables.ts:11-129` | DDL — no recovery table | zero migration needed (derive-only) |
| `packages/core/src/reducer.ts:239-318` | reducer — derives hypothesis state | feeds recovery v0.2 |

**Test rot (pre-phase, must clear in `7r.0`):**

- `apps/dashboard/test` — 4 e2e failures (`sse-live`, `static-serve`).
- `apps/server/test` — 52 failed / 4 passed (out of 56).

## Risks (impact)

| Impact | Risk | Mitigation |
|---|---|---|
| HIGH | Pre-existing test rot masks new AC tests | Land `7r.0` first |
| HIGH | v0.1→v0.2 surface expansion breaks test #4 + dashboard TS shape | Update `state-graph-edges.test.ts:259` + `RecoveryRecord` type in lockstep with endpoint |
| HIGH | Test coverage gap (current 6 recovery tests cover <5% of v0.2) | Each sub-bead writes its own AC tests before close |
| MED | Bundle 49 KB headroom; fuse.js ~6-8 KB + new UI sections | Code-split Recovery Center route (React.lazy); re-run `test:budget` in CI |
| MED | `fuse.js` is first new dep in 6.x | PR body must include "why not FlexSearch/MiniSearch/uFuzzy" per `CONVENTIONS.md:204` |
| MED | No `latestVerificationFor` selector exists | Add to `packages/db` (`cognition-service.ts` or new) in `7r.1` |
| LOW | Zero DB migration | All 8 fields derivable from `SessionState` + events + snapshots |

## Sub-beads

| # | Subject | Est | Depends | ACs |
|---|---|---|---|---|
| `7r.0` | Restore pre-existing test rot | S (2h) | — | dashboard e2e + server all green |
| `7r.1` | Extract `@cognit/recovery` pkg + expand recovery endpoint to v0.2 8-field surface | L (8h) | `7r.0` | 7.4, 7.6–7.11, 7.18 |
| `7r.2` | Add `fuse.js` + `GET /api/sessions/search` | M (6h) | `7r.1` | 7.1, 7.2, 7.3, 7.17, 7.19, 7.20 |
| `7r.3` | CLI `cognit recovery` + `cognit session resume --search` | M (4h) | `7r.1`, `7r.2` | 7.13, 7.14, 7.15 |
| `7r.4` | Dashboard Recovery Center v0.2 (8 fields + search + route split) | L (8h) | `7r.1`, `7r.2` | 7.16 + bundle cap |
| `7r.5` | Server `POST /api/sessions/:id/{dry-run,snapshot,export}` | M (4h) | `7r.1` | wire stubs → real |
| `7r.6` | Polish + verification + `docs/phase-7-results.md` | S (3h) | `7r.1`–`7r.5` | full suite green |

## Acceptance criteria (20, all testable)

### Fuzzy search
- `AC-7.1` Returns ranked matches across goals/findings/hypotheses/decisions/conclusions, ordered by score desc.
- `AC-7.2` Scoped to the 5 entity kinds; does not search observations, event payloads, artifact content, redaction metadata.
- `AC-7.3` Filters: `status`, `project`, `min_confidence` — AND-combined, applied before ranking.
- `AC-7.17` Tolerates single-char typo (transposition/missing/extra).
- `AC-7.19` Deterministic for `(query, filters, data)` tuple.
- `AC-7.20` Does not leak redacted content (raw JWT not matchable; redacted marker matchable).

### Recovery output (server)
- `AC-7.4` Response has all 8 top-level keys: `related_sessions`, `verified_conclusions`, `rejected_hypotheses`, `accepted_decisions`, `rejected_decisions`, `latest_verification`, `last_known_state`, `suggested_next_steps`.
- `AC-7.5` `related_sessions` excludes self; ranked by score.
- `AC-7.6` `verified_conclusions` = conclusions with `state=verified` + `verification_id`.
- `AC-7.7` `rejected_hypotheses` = hypotheses with `current_state=rejected` + `reason_type` + `reason`.
- `AC-7.8` `accepted_decisions` carry `based_on`; `rejected_decisions` carry `reason`.
- `AC-7.9` `latest_verification` per hypothesis = most recent by `created_at`.
- `AC-7.10` `latest_verification` is null for zero-verification hypotheses; never returns older.
- `AC-7.11` `last_known_state` = `snapshot.state_json` if present, else reducer-replay; consistent.
- `AC-7.12` `suggested_next_steps` = highest-gravity active hypothesis (phase 8 fills in; `7r.1` returns `[]`).
- `AC-7.18` Endpoint is read-only (50 calls → no event/snapshot/last_snapshot_event_id mutation).

### CLI
- `AC-7.13` `cognit session resume` emits recovery block (3 fields minimum); new session has `parent_session_id`.
- `AC-7.14` Resume ambiguity → most-recent + warning.
- `AC-7.15` Resume non-existent id → non-zero exit + 404.

### Dashboard
- `AC-7.16` Recovery Center renders all 8 fields for any session with full v0.2 block.

## Cross-cutting constraints

- **No new schema migration** (zero-migration phase).
- **No new dep beyond `fuse.js`** (which is pre-approved in `STACK.md`).
- **`fuse.js` lives in `apps/server` or `packages/recovery`** — NOT `packages/core` (would force fuzzy lib into every consumer bundle: cli, sdk, dashboard-via-core).
- **Update, don't delete** `state-graph-edges.test.ts:259` — strict v0.1 shape lock becomes v0.2 shape lock.
- **Read-only recovery endpoint** — no events written, no snapshot mutation, no reducer side effects.

## Dependency graph

```
7r.0 (test rot)
  └── 7r.1 (@cognit/recovery pkg + v0.2 surface)
        ├── 7r.2 (fuse.js + search endpoint)
        │     ├── 7r.3 (CLI recovery + resume --search)
        │     └── 7r.4 (Dashboard v0.2 + search + route split)
        └── 7r.5 (POST dry-run/snapshot/export)
              (all) ── 7r.6 (polish + verification + results doc)
```

## Commit message format

```
feat: Cognit-7r.<N> <subject>
fix: Cognit-7r.<N> <subject>
```

## Out of scope (defer to phase 8+)

- Gravity engine (powers `suggested_next_steps` non-empty) → phase 8
- Constraint engine → phase 8
- Inbox adapter + auto-capture → phase 9
- Worker-agnostic story → phase 9
