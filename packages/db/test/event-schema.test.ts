import { describe, expect, it } from "vitest";
import { Either, Schema } from "effect";
import { CURRENT_VERSION, EVENT_TYPES, PAYLOAD_SCHEMAS_V1 } from "../src";

describe("event schema registry", () => {
  it("CURRENT_VERSION is 1.0.0", () => {
    expect(CURRENT_VERSION).toBe("1.0.0");
  });

  it("every event type from plan.xml has a schema", () => {
    const required: ReadonlyArray<string> = [
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
    ];
    for (const t of required) {
      expect(EVENT_TYPES).toContain(t);
      expect(PAYLOAD_SCHEMAS_V1[t]).toBeDefined();
    }
  });

  it("session_created requires goal >= 1 char", () => {
    const s = PAYLOAD_SCHEMAS_V1["session_created"] as Schema.Schema<any, any, never>;
    const ok = Schema.decodeUnknownEither(s)({
      goal: "investigate flaky test",
      parent_session_id: null,
    });
    expect(Either.isRight(ok)).toBe(true);
    const bad = Schema.decodeUnknownEither(s)({ goal: "", parent_session_id: null });
    expect(Either.isLeft(bad)).toBe(true);
  });

  it("hypothesis_rejected restricts reason_type to a literal", () => {
    const s = PAYLOAD_SCHEMAS_V1["hypothesis_rejected"] as Schema.Schema<any, any, never>;
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(s)({ reason_type: "evidence", superseded_by_id: null }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(s)({ reason_type: "banana", superseded_by_id: null }),
      ),
    ).toBe(true);
  });

  it("verification_started restricts type to a literal set", () => {
    const s = PAYLOAD_SCHEMAS_V1["verification_started"] as Schema.Schema<any, any, never>;
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(s)({
          command: "pnpm test",
          type: "test",
          linked_hypothesis_id: null,
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(s)({
          command: "pnpm test",
          type: "fruit",
          linked_hypothesis_id: null,
        }),
      ),
    ).toBe(true);
  });

  it("redaction_applied carries pattern + field_path but no content", () => {
    const s = PAYLOAD_SCHEMAS_V1["redaction_applied"] as Schema.Schema<any, any, never>;
    const decoded = Schema.decodeUnknownEither(s)({
      pattern: "jwt",
      entity_type: "observation_recorded",
      entity_id: "01aaaaaaaaaaaaaaaaaaaaaaaa",
      field_path: "text",
    });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      const r = decoded.right as {
        pattern: string;
        entity_type: string;
        entity_id: string | null;
        field_path: string;
      };
      expect(r.pattern).toBe("jwt");
      expect("content" in r).toBe(false);
    }
  });
});
