import { describe, expect, it } from "vitest";
import {
  STATE_EVENT_TYPES,
  NON_STATE_EVENT_TYPES,
  ALL_KNOWN_TYPES,
  STATE_EVENT_TYPES_TUPLE,
  NON_STATE_EVENT_TYPES_TUPLE,
  type StateEventType,
} from "../src/event-types.js";

/**
 * Compile-time + runtime regression for the canonical event-type sets
 * (single source of truth, extracted from reducer.ts). These assertions
 * guard against drift between the runtime Set shapes and the tuple
 * projections used by the compile-time registry check in
 * `packages/db/src/event-schema-keys.ts`.
 */

describe("event-types sets", () => {
  it("ALL_KNOWN_TYPES is the union of STATE_EVENT_TYPES and NON_STATE_EVENT_TYPES", () => {
    const expected = new Set<string>([...STATE_EVENT_TYPES, ...NON_STATE_EVENT_TYPES]);
    expect(ALL_KNOWN_TYPES.size).toBe(expected.size);
    for (const t of expected) {
      expect(ALL_KNOWN_TYPES.has(t)).toBe(true);
    }
  });

  it("STATE_EVENT_TYPES and NON_STATE_EVENT_TYPES have no overlap", () => {
    for (const t of STATE_EVENT_TYPES) {
      expect(NON_STATE_EVENT_TYPES.has(t)).toBe(false);
    }
    for (const t of NON_STATE_EVENT_TYPES) {
      expect(STATE_EVENT_TYPES.has(t)).toBe(false);
    }
  });

  it("STATE_EVENT_TYPES matches STATE_EVENT_TYPES_TUPLE", () => {
    expect(STATE_EVENT_TYPES.size).toBe(STATE_EVENT_TYPES_TUPLE.length);
    for (const t of STATE_EVENT_TYPES_TUPLE) {
      expect(STATE_EVENT_TYPES.has(t)).toBe(true);
    }
  });

  it("NON_STATE_EVENT_TYPES matches NON_STATE_EVENT_TYPES_TUPLE", () => {
    expect(NON_STATE_EVENT_TYPES.size).toBe(NON_STATE_EVENT_TYPES_TUPLE.length);
    for (const t of NON_STATE_EVENT_TYPES_TUPLE) {
      expect(NON_STATE_EVENT_TYPES.has(t)).toBe(true);
    }
  });

  it("STATE_EVENT_TYPES contains the documented types", () => {
    const documented = [
      "session_created",
      "session_paused",
      "session_closed",
      "observation_recorded",
      "finding_created",
      "hypothesis_created",
      "hypothesis_weakened",
      "hypothesis_rejected",
      "hypothesis_promoted",
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
      "hypothesis_ranked",
    ];
    for (const t of documented) {
      expect(STATE_EVENT_TYPES.has(t)).toBe(true);
    }
  });

  it("NON_STATE_EVENT_TYPES contains the documented types", () => {
    const documented = [
      "project_created",
      "actor_registered",
      "redaction_applied",
      "constraint_rule_added",
      "constraint_rule_applied",
      "snapshot_created",
    ];
    for (const t of documented) {
      expect(NON_STATE_EVENT_TYPES.has(t)).toBe(true);
    }
  });
});

describe("event-types switch exhaustiveness", () => {
  /**
   * If a new event type is added to `STATE_EVENT_TYPES_TUPLE`, the
   * `StateEventType` union expands and this switch would fail to
   * compile until the missing `case` is added. The `default` branch
   * is deliberately omitted — TypeScript's `never` narrowing only
   * triggers when every union member is handled.
   */
  const fold = (t: StateEventType): "state" => {
    switch (t) {
      case "session_created":
      case "session_paused":
      case "session_closed":
      case "observation_recorded":
      case "finding_created":
      case "hypothesis_created":
      case "hypothesis_weakened":
      case "hypothesis_rejected":
      case "hypothesis_promoted":
      case "theory_created":
      case "theory_updated":
      case "theory_merged":
      case "theory_archived":
      case "experiment_created":
      case "experiment_completed":
      case "decision_proposed":
      case "decision_accepted":
      case "decision_rejected":
      case "decision_superseded":
      case "conclusion_proposed":
      case "conclusion_verified":
      case "conclusion_rejected":
      case "verification_started":
      case "verification_passed":
      case "verification_failed":
      case "verification_errored":
      case "verification_cancelled":
      case "verification_rerun":
      case "artifact_attached":
      case "edge_created":
      case "hypothesis_ranked":
        return "state";
    }
  };

  it("switch over StateEventType covers every tuple member", () => {
    for (const t of STATE_EVENT_TYPES_TUPLE) {
      expect(fold(t)).toBe("state");
    }
  });
});
