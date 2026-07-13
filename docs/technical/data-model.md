# Data model

Cognit stores engineering cognition as an append-only event log. State is a
pure projection of that log — there is no parallel "current state" table.

## Tables

SQLite DDL lives in `packages/db/src/schema/tables.ts` (raw `CREATE TABLE`
statements — see the file header at line 1 for the rationale). The
TypeScript row types live alongside in `packages/db/src/schema/rows.ts`.

| Table             | PK       | Purpose                                                                                                            |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `projects`        | `id`     | One row per initialised Cognit project. Created by `cognit init` (`tables.ts:12`).                                |
| `sessions`        | `id`     | Investigation session inside a project. Has `status` ∈ `active`/`paused`/`closed` and optional `parent_session_id` for forks. Pointer to the latest snapshot at `last_snapshot_event_id` (`tables.ts:19`). |
| `actors`          | `id`     | Registered emitters of events: `human`, `worker`, or `system`. Uniqueness on `name`. Carries `trust_score` and config JSON (`tables.ts:30`). |
| `events`          | `id`     | Append-only event log. `type` is the discriminator; `payload_json` holds the type-specific body. `causation_id` + `correlation_id` give basic causality. FKs to `projects`, `sessions`, `actors`, and self-references for `parent_verification_id` / `linked_hypothesis_id` (`tables.ts:40`). |
| `snapshots`       | `id`     | Frozen projection of a session's state at `event_id`, with `event_count` and the folded `state_json`. Used for fast cold-start (`tables.ts:67`). |
| `artifacts`       | `id`     | Content-addressed file attached to a session. `sha256` + `size_bytes` + `kind`. May be archived (`archived_at`) when GC runs (`tables.ts:76`). |
| `edges`           | `id`     | Typed relationship between two entities: `from_entity_type`/`from_entity_id` → `to_entity_type`/`to_entity_id`. Indexed both directions (`tables.ts:87`). |
| `constraint_rules`| `id`     | User-defined guardrails. JSON `condition` + JSON `actions`, `enabled` flag (`tables.ts:101`). |
| `schema_version`  | `id=1`   | Singleton row holding the migration version + `applied_at` (`tables.ts:109`). |
| `hypotheses`      | `id`     | Cached row for hypothesis lifecycle (`active`/`weakened`/`rejected`/`promoted`). Updated via hypothesis lifecycle events (`tables.ts:115`). |
| `inbox_processed` | `id`     | Inbox sidecar bookkeeping: one row per successfully processed `.cognit/inbox/*.json` (`tables.ts:124`). |

Index highlights (see `tables.ts:58` for `events` and `tables.ts:97` for
`edges`) cover the four hot scan paths: `events(session_id, created_at)`,
`events(project_id, type, created_at)`, `events(actor_id, created_at)`, and
`events(linked_hypothesis_id, created_at)`.

### Pragmas

Open pragmas are constants in `tables.ts:132`:

- `journal_mode = WAL` — crash-safe with concurrent readers.
- `synchronous = NORMAL` — fsync at commit; WAL handles the rest.
- `foreign_keys = ON` — referential integrity is real, not aspirational.
- `busy_timeout = 5000` — tolerate 5s of lock contention.

## Events

Every state transition is an event. The reducer recognises two families,
declared as `Set<string>` literals at the top of `packages/core/src/reducer.ts`:

- State-folding events (`reducer.ts:42`) — `session_created`,
  `session_paused`, `session_closed`, `observation_recorded`, `finding_created`,
  `hypothesis_created`, `hypothesis_weakened`, `hypothesis_rejected`,
  `hypothesis_promoted`, `theory_created`, `theory_updated`, `theory_merged`,
  `theory_archived`, `experiment_created`, `experiment_completed`,
  `decision_proposed`, `decision_accepted`, `decision_rejected`,
  `decision_superseded`, `conclusion_proposed`, `conclusion_verified`,
  `conclusion_rejected`, `verification_started`, `verification_passed`,
  `verification_failed`, `verification_errored`, `verification_cancelled`,
  `verification_rerun`, `artifact_attached`, `edge_created`,
  `hypothesis_ranked`.
- Non-state events (`reducer.ts:76`) — `project_created`, `actor_registered`,
  `redaction_applied`, `constraint_rule_added`, `constraint_rule_applied`,
  `snapshot_created`. These are recorded for audit but do not change the
  folded state.

The wire envelope published into `.cognit/inbox/` is documented in
[hooks/README.md](../hooks/README.md) (current shape: `version: "1.2.0"` — see
[Envelope v1.2.0](./events.md#envelope-v120-current) for the full field
table); the runtime schema registry lives in
`packages/db/src/event-schema.ts`.

## Reducer

`packages/core/src/reducer.ts` is a **total** pure function over the event
log: every known event type has a branch in `applyEvent`, so the caller can
hand in an unfiltered `EventRow[]` and the function will never throw and
never silently drop a transition (see the file header at `reducer.ts:1`).

Key properties:

- **Replay order** — events are sorted by `(created_at ASC, id ASC)`
  (`sortEvents` at `reducer.ts:96`). ULIDs are monotonic 26-char strings, so
  string-sort is a stable tiebreaker for same-millisecond writes.
- **Snapshot restore** — when a snapshot is supplied, the reducer treats it
  as the state immediately after `snapshot_event_id` was applied and folds
  only events whose id sorts strictly after it (`reducer.ts:13`). This makes
  the reducer usable for both cold-start replay and snapshot+tail rebuild.
- **Session-scoped current pointers** — events without an entity id in the
  payload (e.g. `hypothesis_weakened`) apply to the session's `current_*`
  pointer maintained by the reducer (`reducer.ts:19`). Pointers advance on
  `*_created` / `*_proposed` / `verification_started`.

The reducer emits a `SessionState` value object whose shape is defined in
`packages/core/src/state.ts`; that state is what the dashboard, server, and
CLI all read back from.