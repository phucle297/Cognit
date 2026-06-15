import { describe, expect, it } from "vitest";
import { evalRules, decodePredicate, type EngineRule, type CandidateEvent } from "../src/constraint-engine";
import { emptySessionState } from "@cognit/core/state";

const sessionId = "01SESS00000000000000000000";
const projectId = "01PROJ00000000000000000000";

const baseState = emptySessionState({
  session_id: sessionId,
  project_id: projectId,
  goal: "test",
});

const baseCandidate: CandidateEvent = {
  type: "observation_recorded",
  payload: { text: "hello" },
  actorTrustScore: 1.0,
  sessionEventCount: 0,
};

describe("constraint engine", () => {
  it("allows when no rules", () => {
    const r = evalRules([], baseState, baseCandidate);
    expect(r.allow).toBe(true);
    expect(r.matchedRuleIds).toEqual([]);
  });

  it("event.type predicate matches", () => {
    const rule: EngineRule = {
      rule_id: "r1",
      when: { kind: "event.type", equals: "observation_recorded" },
      then: { kind: "block" },
      reason: "no observations",
    };
    const r = evalRules([rule], baseState, baseCandidate);
    expect(r.allow).toBe(false);
    expect(r.violation?.ruleId).toBe("r1");
  });

  it("event.type predicate does NOT match when type differs", () => {
    const rule: EngineRule = {
      rule_id: "r1",
      when: { kind: "event.type", equals: "hypothesis_promoted" },
      then: { kind: "block" },
      reason: "no promotions",
    };
    const r = evalRules([rule], baseState, baseCandidate);
    expect(r.allow).toBe(true);
  });

  it("event.payload.equals matches the payload field", () => {
    const rule: EngineRule = {
      rule_id: "r2",
      when: { kind: "event.payload.equals", field: "text", value: "hello" },
      then: { kind: "block" },
      reason: "no hello",
    };
    const r = evalRules([rule], baseState, baseCandidate);
    expect(r.allow).toBe(false);
  });

  it("event.payload.not_equals matches when field is absent", () => {
    const rule: EngineRule = {
      rule_id: "r3",
      when: { kind: "event.payload.not_equals", field: "missing_field", value: "x" },
      then: { kind: "block" },
      reason: "must include missing_field",
    };
    const r = evalRules([rule], baseState, baseCandidate);
    expect(r.allow).toBe(false);
  });

  it("actor.trust_score_gte allows high-trust actors", () => {
    const rule: EngineRule = {
      rule_id: "r4",
      when: { kind: "actor.trust_score_gte", value: 0.5 },
      then: { kind: "block" },
      reason: "trust too low",
    };
    const r = evalRules([rule], baseState, {
      ...baseCandidate,
      actorTrustScore: 0.9,
    });
    expect(r.allow).toBe(false);
  });

  it("actor.trust_score_gte does NOT block higher trust", () => {
    const rule: EngineRule = {
      rule_id: "r4",
      when: { kind: "actor.trust_score_gte", value: 0.5 },
      then: { kind: "block" },
      reason: "trust too low",
    };
    const r = evalRules([rule], baseState, {
      ...baseCandidate,
      actorTrustScore: 0.1,
    });
    expect(r.allow).toBe(true);
  });

  it("state.open_hypotheses.length_gt fires when more open hypotheses than n", () => {
    const rule: EngineRule = {
      rule_id: "r5",
      when: { kind: "state.open_hypotheses.length_gt", value: 1 },
      then: { kind: "block" },
      reason: "too many open hypotheses",
    };
    const r = evalRules(
      [rule],
      {
        ...baseState,
        hypotheses: new Map<string, import("@cognit/core/state").HypothesisState>([
          [
            "h1",
            {
              id: "h1",
              title: "t",
              text: "b",
              current_state: "active",
              current_confidence: null,
              current_reason: null,
              reason_type: null,
              superseded_by_id: null,
              promoted_to_theory_id: null,
              belongs_to_theory_id: null,
              created_at: "2026-06-15T00:00:00.000Z",
              last_event_id: "e1",
              last_event_at: "2026-06-15T00:00:00.000Z",
            },
          ],
          [
            "h2",
            {
              id: "h2",
              title: "t",
              text: "b",
              current_state: "active",
              current_confidence: null,
              current_reason: null,
              reason_type: null,
              superseded_by_id: null,
              promoted_to_theory_id: null,
              belongs_to_theory_id: null,
              created_at: "2026-06-15T00:00:00.000Z",
              last_event_id: "e2",
              last_event_at: "2026-06-15T00:00:00.000Z",
            },
          ],
        ]),
      },
      baseCandidate,
    );
    expect(r.allow).toBe(false);
  });

  it("state.edges.exists fires when an edge matches", () => {
    const rule: EngineRule = {
      rule_id: "r6",
      when: {
        kind: "state.edges.exists",
        fromId: "f1",
        toId: "t1",
        edgeType: "supports",
      },
      then: { kind: "block" },
      reason: "edge already exists",
    };
    const r = evalRules(
      [rule],
      {
        ...baseState,
        edges: [
          {
            id: "e1",
            edge_type: "supports",
            from_entity_type: "finding",
            from_entity_id: "f1",
            to_entity_type: "hypothesis",
            to_entity_id: "t1",
            created_at: "2026-06-15T00:00:00.000Z",
          },
        ],
      },
      baseCandidate,
    );
    expect(r.allow).toBe(false);
  });

  it("returns the first matching rule as the violation (declaration order)", () => {
    const r1: EngineRule = {
      rule_id: "r1",
      when: { kind: "event.type", equals: "observation_recorded" },
      then: { kind: "block" },
      reason: "first",
    };
    const r2: EngineRule = {
      rule_id: "r2",
      when: { kind: "event.type", equals: "observation_recorded" },
      then: { kind: "block" },
      reason: "second",
    };
    const r = evalRules([r1, r2], baseState, baseCandidate);
    expect(r.allow).toBe(false);
    expect(r.violation?.ruleId).toBe("r1");
    expect(r.violation?.reason).toBe("first");
  });

  it("decodePredicate accepts a valid wire predicate", () => {
    const p = decodePredicate(JSON.stringify({ kind: "event.type", equals: "x" }));
    expect(p.kind).toBe("event.type");
  });

  it("decodePredicate rejects a malformed predicate", () => {
    expect(() => decodePredicate(JSON.stringify({ kind: "unknown" }))).toThrow();
  });
});
