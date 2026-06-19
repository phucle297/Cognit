-- 0004_constraint_action_log_v1.3.0.sql
--
-- Phase 8 v0.2 (Cognit-8g.3) — post-append constraint-engine dedup table.
--
-- Each time the constraint engine fires a non-block action (one of
-- `reject_hypothesis`, `weaken_hypothesis`, `promote_hypothesis`,
-- `create_finding`) on a triggering event, the transformer records
-- the `(event_id, rule_id, action_type)` triple here. A second pass
-- for the same triple is skipped via `INSERT OR IGNORE`.
--
-- This is the second additive migration in phase 8 (8g.1 added
-- `hypotheses.gravity_fired_at`). Approved as part of the phase 8
-- additive-migrations sign-off (see plan
-- `docs/superpowers/plans/2026-06-19-phase-8-gravity-constraint.md`
-- §Risks HIGH row 1 — loop guard mitigation).
--
-- Idempotency: `CREATE TABLE IF NOT EXISTS` is native to SQLite. The
-- migration runner's `schema_version` gate in `migrations.ts` is the
-- primary re-run protection; the IF NOT EXISTS is the belt-and-braces
-- measure for hand-applied DBs in dev test harnesses.
--
-- Schema rationale:
--   * `event_id` — the original trigger event id (the one whose payload
--     matched the rule's predicate). For the constraint engine's own
--     emitted events, this is the cause-event id stored in the emitted
--     payload; the dedup row itself uses a different key path (see
--     `evalTransformRules` for the rule-emitted dedup path).
--   * `rule_id` — the id of the rule that fired.
--   * `action_type` — the action kind string (`reject_hypothesis`, etc).
--   * `fired_at` — epoch seconds; same convention as
--     `gravity_fired_at` (REAL, JS-friendly float math).
--   * PRIMARY KEY(event_id, rule_id, action_type) — composite unique
--     constraint backs the INSERT OR IGNORE dedup. SQLite enforces
--     uniqueness atomically per INSERT.
--
-- Indexes: PK is enough for the dedup lookup (point query). We do
-- NOT add a redundant UNIQUE INDEX — the PK itself satisfies the
-- query plan and `INSERT OR IGNORE` performance is irrelevant given
-- the per-tx write frequency.

CREATE TABLE IF NOT EXISTS constraint_action_log (
  event_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  fired_at REAL NOT NULL,
  PRIMARY KEY (event_id, rule_id, action_type)
);
