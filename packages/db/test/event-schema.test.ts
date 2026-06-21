import { describe, expect, it } from "vitest";
import { Either, Schema } from "effect";
import {
  CURRENT_VERSION,
  EVENT_TYPES,
  PAYLOAD_SCHEMAS_V1,
  PAYLOAD_SCHEMAS_V1_1_0,
  PAYLOAD_SCHEMAS_V1_2_0,
} from "../src";

describe("event schema registry", () => {
  it("CURRENT_VERSION is 1.2.0", () => {
    expect(CURRENT_VERSION).toBe("1.2.0");
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

  it("v1.1.0 verification_passed decodes exit_code / duration_ms / stdout_excerpt / created_artifact_id", () => {
    const s = PAYLOAD_SCHEMAS_V1_1_0["verification_passed"] as Schema.Schema<any, any, never>;
    const full = Schema.decodeUnknownEither(s)({
      exit_code: 0,
      duration_ms: 1234,
      stdout_excerpt: "ok 1\nok 2",
      created_artifact_id: "01artxxxxxxxxxxxxxxxxxxxxxx",
    });
    expect(Either.isRight(full)).toBe(true);
    if (Either.isRight(full)) {
      const r = full.right as Record<string, unknown>;
      expect(r.exit_code).toBe(0);
      expect(r.duration_ms).toBe(1234);
      expect(r.stdout_excerpt).toBe("ok 1\nok 2");
      expect(r.created_artifact_id).toBe("01artxxxxxxxxxxxxxxxxxxxxxx");
    }
    // Empty body still decodes (all new fields are optional with defaults).
    const empty = Schema.decodeUnknownEither(s)({});
    expect(Either.isRight(empty)).toBe(true);
  });

  it("v1.1.0 verification_failed decodes new fields while keeping stderr_excerpt required", () => {
    const s = PAYLOAD_SCHEMAS_V1_1_0["verification_failed"] as Schema.Schema<any, any, never>;
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(s)({
          stderr_excerpt: "boom",
          exit_code: 2,
          duration_ms: 500,
          stdout_excerpt: null,
          created_artifact_id: null,
        }),
      ),
    ).toBe(true);
    // stderr_excerpt still required.
    expect(Either.isLeft(Schema.decodeUnknownEither(s)({}))).toBe(true);
  });

  it("v1.1.0 verification_errored / cancelled carry optional duration_ms", () => {
    const errored = PAYLOAD_SCHEMAS_V1_1_0["verification_errored"] as Schema.Schema<any, any, never>;
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(errored)({ error: "ENOENT", duration_ms: 42 }),
      ),
    ).toBe(true);
    const cancelled = PAYLOAD_SCHEMAS_V1_1_0["verification_cancelled"] as Schema.Schema<any, any, never>;
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(cancelled)({ reason: "user_aborted", duration_ms: 7 }),
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

  it("v1.2.0 registers hypothesis_ranked but not in v1.1.0 (additive only)", () => {
    expect(PAYLOAD_SCHEMAS_V1_2_0["hypothesis_ranked"]).toBeDefined();
    expect(PAYLOAD_SCHEMAS_V1_1_0["hypothesis_ranked"]).toBeUndefined();
    expect(PAYLOAD_SCHEMAS_V1["hypothesis_ranked"]).toBeUndefined();
    expect(EVENT_TYPES).toContain("hypothesis_ranked");
  });

  it("v1.2.0 hypothesis_ranked decodes a valid override payload", () => {
    const s = PAYLOAD_SCHEMAS_V1_2_0["hypothesis_ranked"] as Schema.Schema<any, any, never>;
    const decoded = Schema.decodeUnknownEither(s)({
      hypothesis_id: "01hypxxxxxxxxxxxxxxxxxxxxxx",
      score: 0.72,
      reasoning: "Strongest evidence + reproducible",
      evaluator: "ai-supervisor",
      override_rule_based: true,
      context_event_ids: ["01obsxxxxxxxxxxxxxxxxxxxxxx", "01expxxxxxxxxxxxxxxxxxxxxxx"],
    });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      const r = decoded.right as Record<string, unknown>;
      expect(r.score).toBe(0.72);
      expect(r.evaluator).toBe("ai-supervisor");
      expect(r.override_rule_based).toBe(true);
    }
  });

  it("v1.2.0 hypothesis_ranked score must be in [0, 1]", () => {
    const s = PAYLOAD_SCHEMAS_V1_2_0["hypothesis_ranked"] as Schema.Schema<any, any, never>;
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(s)({
          hypothesis_id: "01hypxxxxxxxxxxxxxxxxxxxxxx",
          score: 1.5,
          reasoning: "over-range",
          evaluator: "ai-supervisor",
          override_rule_based: false,
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(s)({
          hypothesis_id: "01hypxxxxxxxxxxxxxxxxxxxxxx",
          score: -0.1,
          reasoning: "under-range",
          evaluator: "ai-supervisor",
          override_rule_based: false,
        }),
      ),
    ).toBe(true);
  });

  it("v1.2.0 hypothesis_ranked evaluator restricted to ai-supervisor literal", () => {
    const s = PAYLOAD_SCHEMAS_V1_2_0["hypothesis_ranked"] as Schema.Schema<any, any, never>;
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(s)({
          hypothesis_id: "01hypxxxxxxxxxxxxxxxxxxxxxx",
          score: 0.5,
          reasoning: "x",
          evaluator: "human",
          override_rule_based: false,
        }),
      ),
    ).toBe(true);
  });

  it("v1.2.0 hypothesis_ranked requires hypothesis_id + score + reasoning + evaluator + override_rule_based", () => {
    const s = PAYLOAD_SCHEMAS_V1_2_0["hypothesis_ranked"] as Schema.Schema<any, any, never>;
    expect(Either.isLeft(Schema.decodeUnknownEither(s)({}))).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(s)({
          hypothesis_id: "",
          score: 0.5,
          reasoning: "x",
          evaluator: "ai-supervisor",
          override_rule_based: true,
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(s)({
          hypothesis_id: "01hypxxxxxxxxxxxxxxxxxxxxxx",
          score: 0.5,
          reasoning: "",
          evaluator: "ai-supervisor",
          override_rule_based: true,
        }),
      ),
    ).toBe(true);
  });

  it("v1.2.0 schema map is a strict superset of v1.1.0 (every v1.1.0 type still defined)", () => {
    for (const t of Object.keys(PAYLOAD_SCHEMAS_V1_1_0)) {
      expect(PAYLOAD_SCHEMAS_V1_2_0[t]).toBeDefined();
    }
  });
});
