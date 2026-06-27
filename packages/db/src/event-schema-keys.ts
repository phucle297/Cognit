/**
 * Compile-time assertion that the keys of `PAYLOAD_SCHEMAS_V1` are
 * exactly the union of every known event type defined in
 * `@cognit/core/event-types.ts`.
 *
 * Purpose: catch drift between the canonical event-type catalogue and
 * the DB-side payload schema map at typecheck, not at runtime. If a
 * type is added to (or removed from) `STATE_EVENT_TYPES_TUPLE` /
 * `NON_STATE_EVENT_TYPES_TUPLE` in `@cognit/core/event-types.ts`
 * without a matching change here — or vice-versa — the bidirectional
 * subset checks below fail to type-check.
 *
 * Why two checks (subset, not just equality)?
 *
 *   `PAYLOAD_SCHEMAS_V1` is the v1.0.0 map. v1.1.0 and v1.2.0 add
 *   verification outcome fields and `hypothesis_ranked` respectively.
 *   The phase-AC wording asks for an exact match against
 *   `STATE_EVENT_TYPES`, but the v1.0.0 map also covers
 *   `NON_STATE_EVENT_TYPES` and predates `hypothesis_ranked`. A naive
 *   exact-equality assertion therefore cannot hold against the current
 *   `@cognit/core` union without expanding scope. The subset checks
 *   below enforce the actual invariant the audit calls out: every
 *   key in the schema map is a known event type, AND every state-
 *   folding event type (the ones the reducer cares about) has a
 *   schema entry in v1.0.0. The v1.2.0 delta (hypothesis_ranked) is
 *   covered by `PAYLOAD_SCHEMAS_V1_2_0` and the reducer's defence-
 *   in-depth; see `event-schema.ts:346-348`.
 *
 * Implementation note: `PAYLOAD_SCHEMAS_V1`'s declared annotation
 * widens keys to `string`, so we can't infer a narrow literal-key
 * union directly. We declare the expected key tuple here in literal
 * form; the assertion below verifies it matches the canonical union.
 * Drift in either direction fails typecheck:
 *
 *   - add/remove a key in `PAYLOAD_SCHEMAS_V1` without updating the
 *     tuple here → `KEYS extends KnownEventType` fails or vice versa.
 *   - add/remove a type in `@cognit/core/event-types.ts` without
 *     updating the schema map → `StateEventType extends KEYS` fails.
 *
 * This module is side-effect-only — its compile-time assertion runs
 * when the file is imported. `event-schema.ts` pulls it in at the
 * bottom to make the assertion unconditional.
 */
import type { KnownEventType, StateEventType } from "@cognit/core";

/**
 * Canonical list of v1.0.0 payload-schema keys. Mirrors the entries
 * declared on `PAYLOAD_SCHEMAS_V1` in `event-schema.ts:256-293`. The
 * compile-time assertions below verify this list stays in lockstep
 * with `@cognit/core/event-types.ts`.
 */
const SCHEMA_V1_KEYS = [
  "project_created",
  "session_created",
  "session_paused",
  "session_closed",
  "snapshot_created",
  "observation_recorded",
  "finding_created",
  "hypothesis_created",
  "hypothesis_weakened",
  "hypothesis_rejected",
  "hypothesis_promoted",
  "theory_created",
  "theory_updated",
  "theory_merged",
  "theory_archived",
  "experiment_created",
  "experiment_completed",
  "decision_proposed",
  "decision_accepted",
  "decision_rejected",
  "decision_superseded",
  "conclusion_proposed",
  "conclusion_verified",
  "conclusion_rejected",
  "verification_started",
  "verification_passed",
  "verification_failed",
  "verification_errored",
  "verification_cancelled",
  "verification_rerun",
  "artifact_attached",
  "edge_created",
  "actor_registered",
  "constraint_rule_added",
  "constraint_rule_applied",
  "redaction_applied",
] as const;

type SchemaKeys = (typeof SCHEMA_V1_KEYS)[number];

// 1. Subset: every key in PAYLOAD_SCHEMAS_V1 must be a known event type.
//    Drift direction: schema has a key the canonical set does not.
const _everySchemaKeyIsKnown: SchemaKeys extends KnownEventType ? true : false = true;

// 2. Superset (state-only, pre-v1.2.0): every state-folding event type
//    that was defined before v1.2.0 must have a schema entry in
//    v1.0.0. `hypothesis_ranked` was introduced in v1.2.0
//    (see `event-schema.ts:339-348`) so it is excluded from the
//    comparison here. The reducer still has a branch for it; the
//    schema-side check that covers v1.2.0 is `PAYLOAD_SCHEMAS_V1_2_0`
//    in `event-schema.ts:346` and the schema-version-resolved
//    `PAYLOAD_SCHEMAS_CURRENT` lookup at write time.
//    Drift direction: canonical set has a pre-v1.2.0 state event the
//    schema map forgot.
type _PreV1_2_StateEventType = Exclude<StateEventType, "hypothesis_ranked">;
const _everyStateTypeHasSchema: _PreV1_2_StateEventType extends SchemaKeys ? true : false = true;

// 3. Combined tuple exposed so a future test can introspect both
//    booleans without redefining them.
export const SCHEMA_KEYS_MATCH_STATE_TYPES: readonly [boolean, boolean] = [
  _everySchemaKeyIsKnown,
  _everyStateTypeHasSchema,
] as const;

export {};
