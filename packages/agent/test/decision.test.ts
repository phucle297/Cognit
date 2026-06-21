/**
 * packages/agent/test/decision.test.ts — AgentDecision codec.
 *
 * Cases:
 *  1. valid minimal decision decodes (schema_version "1", empty arrays, stop=false)
 *  2. each action variant decodes (weaken/reject/promote/propose/request)
 *  3. rank_overrides defaults to [] when absent
 *  4. unknown schema_version rejects
 *  5. missing schema_version rejects
 *  6. malformed action payload rejects (e.g. reason_type wrong literal)
 *  7. rank_overrides with out-of-range score rejects
 *  8. encode round-trips: decode(encode(d)) === d
 *  9. stop=true accepted (boolean both values)
 * 10. rationale is required (empty string rejected)
 */
import { describe, it, expect } from "vitest";
import {
  decodeAgentDecisionEither,
  encodeAgentDecision,
  type AgentDecision,
} from "../src/decision.js";

const baseValid: AgentDecision = {
  schema_version: "1",
  rationale: "x",
  actions: [],
  rank_overrides: [],
  stop: false,
};

describe("AgentDecision codec", () => {
  it("1. minimal valid decision decodes", () => {
    const r = decodeAgentDecisionEither(baseValid);
    expect(r._tag).toBe("Right");
  });

  it("2a. weaken_hypothesis action decodes", () => {
    const r = decodeAgentDecisionEither({
      ...baseValid,
      actions: [{ kind: "weaken_hypothesis", hypothesis_id: "H-1", reason: "lost support" }],
    });
    expect(r._tag).toBe("Right");
  });

  it("2b. reject_hypothesis action decodes (each reason_type literal)", () => {
    for (const rt of ["evidence", "superseded", "constraint"] as const) {
      const r = decodeAgentDecisionEither({
        ...baseValid,
        actions: [{ kind: "reject_hypothesis", hypothesis_id: "H-1", reason_type: rt }],
      });
      expect(r._tag).toBe("Right");
    }
  });

  it("2c. promote_hypothesis action decodes", () => {
    const r = decodeAgentDecisionEither({
      ...baseValid,
      actions: [
        { kind: "promote_hypothesis", hypothesis_id: "H-1", promoted_to_theory_id: "T-1" },
      ],
    });
    expect(r._tag).toBe("Right");
  });

  it("2d. propose_decision action decodes", () => {
    const r = decodeAgentDecisionEither({
      ...baseValid,
      actions: [{ kind: "propose_decision", text: "ship it", based_on_conclusion_ids: [] }],
    });
    expect(r._tag).toBe("Right");
  });

  it("2e. request_verification action decodes (each type literal)", () => {
    for (const t of ["test", "lint", "build", "exec", "typecheck"] as const) {
      const r = decodeAgentDecisionEither({
        ...baseValid,
        actions: [{ kind: "request_verification", command: "vitest run", type: t }],
      });
      expect(r._tag).toBe("Right");
    }
  });

  it("3. rank_overrides defaults to [] when absent", () => {
    const noOverride = { ...baseValid } as Record<string, unknown>;
    delete noOverride["rank_overrides"];
    const r = decodeAgentDecisionEither(noOverride);
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") {
      expect(r.right.rank_overrides).toEqual([]);
    }
  });

  it("4. unknown schema_version rejects", () => {
    const r = decodeAgentDecisionEither({ ...baseValid, schema_version: "2" });
    expect(r._tag).toBe("Left");
  });

  it("5. missing schema_version rejects", () => {
    const stripped = { ...baseValid } as Record<string, unknown>;
    delete stripped["schema_version"];
    const r = decodeAgentDecisionEither(stripped);
    expect(r._tag).toBe("Left");
  });

  it("6. malformed action payload rejects (bad reason_type literal)", () => {
    const r = decodeAgentDecisionEither({
      ...baseValid,
      actions: [{ kind: "reject_hypothesis", hypothesis_id: "H-1", reason_type: "garbage" }],
    });
    expect(r._tag).toBe("Left");
  });

  it("7. rank_overrides with out-of-range score rejects", () => {
    const r = decodeAgentDecisionEither({
      ...baseValid,
      rank_overrides: [{ hypothesis_id: "H-1", score: 1.5, reasoning: "too high" }],
    });
    expect(r._tag).toBe("Left");
  });

  it("8. encode round-trip: decode(encode(d)) equals d", () => {
    const original: AgentDecision = {
      schema_version: "1",
      rationale: "round-trip me",
      actions: [{ kind: "weaken_hypothesis", hypothesis_id: "H-7", reason: "convincing" }],
      rank_overrides: [{ hypothesis_id: "H-7", score: 0.42, reasoning: "demo" }],
      stop: false,
    };
    const encoded = encodeAgentDecision(original);
    const re = decodeAgentDecisionEither(encoded);
    expect(re._tag).toBe("Right");
    if (re._tag === "Right") {
      expect(re.right).toEqual(original);
    }
  });

  it("9. stop boolean accepts both values", () => {
    for (const s of [true, false]) {
      const r = decodeAgentDecisionEither({ ...baseValid, stop: s });
      expect(r._tag).toBe("Right");
    }
  });

  it("10. rationale required (empty string rejected by minLength)", () => {
    const r = decodeAgentDecisionEither({ ...baseValid, rationale: "" });
    expect(r._tag).toBe("Left");
  });

  it("11. encode returns a JSON-serialisable value", () => {
    const encoded = encodeAgentDecision(baseValid);
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(baseValid);
  });
});
