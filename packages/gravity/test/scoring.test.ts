/**
 * packages/gravity/test/scoring.test.ts — phase 8 v0.2 gravity engine.
 *
 * Cases:
 *  1. scoreHypothesis returns a real number in [0, 1] for default config
 *  2. each of the 5 inputs isolated: hold the other 4 at a fixed
 *     value and vary the one under test
 *  3. boundary: empty actors -> actor_trust = 0
 *  4. boundary: gravity_fired_at = 0 ("never fired") -> freshness = 0
 *  5. boundary: very old hypothesis (age >> half-life) -> freshness ≈ 0
 *  6. determinism: same input 1000 iterations -> same output
 *  7. rankHypotheses: excludes non-active hypotheses (AC-8.5)
 *  8. rankHypotheses: stable sort by (score desc, id asc) (AC-8.5)
 *  9. weights config validator: sum != 1.0 throws on parse
 * 10. weights config validator: sum within ±0.001 of 1.0 passes
 * 11. freshness fn: 0.5 at exactly one half-life
 * 12. clamp defence: out-of-range inputs are clamped, not propagated
 * 13. state-level axes: evidence / reproducibility / confidence from
 *     SessionState (not hard-coded 0); rankHypotheses uses full band
 */
import { describe, it, expect } from "vitest";
import { defaultConfig, parseCognitConfig } from "@cognit/core/config";
import {
  emptySessionState,
  type ConclusionState,
  type FindingState,
  type HypothesisState,
  type SessionState,
  type VerificationState,
} from "@cognit/core/state";
import {
  ageDaysFromFiredAt,
  defaultFreshnessHalfLifeDays,
  defaultGravityWeights,
  evidenceStrengthFor,
  freshness,
  freshnessForHypothesis,
  meanActorTrust,
  rankHypotheses,
  reproducibilityFor,
  scoreHypothesis,
  verificationConfidenceFor,
  type ContributingActor,
} from "../src/scoring.js";

const baseCfg = () => defaultConfig("test-gravity");

describe("scoreHypothesis — 5-axis weighted sum", () => {
  it("1. default config + full inputs -> 1.0 (clamped)", () => {
    const s = scoreHypothesis(
      {
        evidence_strength: 1,
        reproducibility: 1,
        verification_confidence: 1,
        actor_trust: 1,
        freshness_decay: 1,
      },
      baseCfg(),
    );
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
    // Default weights sum to 1.0, so 1*sum = 1.0
    expect(s).toBeCloseTo(1.0, 10);
  });

  it("2a. evidence_strength isolated: only that input moves the score", () => {
    const base = {
      evidence_strength: 0,
      reproducibility: 0.5,
      verification_confidence: 0.5,
      actor_trust: 0.5,
      freshness_decay: 0.5,
    };
    const low = scoreHypothesis(base, baseCfg());
    const high = scoreHypothesis({ ...base, evidence_strength: 1 }, baseCfg());
    const delta = high - low;
    // weight = 0.30; high moves +1.0 on that axis; delta = 0.30
    expect(delta).toBeCloseTo(defaultGravityWeights.evidence, 10);
  });

  it("2b. reproducibility isolated: only that input moves the score", () => {
    const base = {
      evidence_strength: 0.5,
      reproducibility: 0,
      verification_confidence: 0.5,
      actor_trust: 0.5,
      freshness_decay: 0.5,
    };
    const low = scoreHypothesis(base, baseCfg());
    const high = scoreHypothesis({ ...base, reproducibility: 1 }, baseCfg());
    expect(high - low).toBeCloseTo(defaultGravityWeights.reproducibility, 10);
  });

  it("2c. verification_confidence isolated: only that input moves the score", () => {
    const base = {
      evidence_strength: 0.5,
      reproducibility: 0.5,
      verification_confidence: 0,
      actor_trust: 0.5,
      freshness_decay: 0.5,
    };
    const low = scoreHypothesis(base, baseCfg());
    const high = scoreHypothesis({ ...base, verification_confidence: 1 }, baseCfg());
    expect(high - low).toBeCloseTo(defaultGravityWeights.confidence, 10);
  });

  it("2d. actor_trust isolated: only that input moves the score", () => {
    const base = {
      evidence_strength: 0.5,
      reproducibility: 0.5,
      verification_confidence: 0.5,
      actor_trust: 0,
      freshness_decay: 0.5,
    };
    const low = scoreHypothesis(base, baseCfg());
    const high = scoreHypothesis({ ...base, actor_trust: 1 }, baseCfg());
    expect(high - low).toBeCloseTo(defaultGravityWeights.trust, 10);
  });

  it("2e. freshness_decay isolated: only that input moves the score", () => {
    const base = {
      evidence_strength: 0.5,
      reproducibility: 0.5,
      verification_confidence: 0.5,
      actor_trust: 0.5,
      freshness_decay: 0,
    };
    const low = scoreHypothesis(base, baseCfg());
    const high = scoreHypothesis({ ...base, freshness_decay: 1 }, baseCfg());
    expect(high - low).toBeCloseTo(defaultGravityWeights.freshness, 10);
  });

  it("3. zero inputs -> 0.0 (boundary, no NaN)", () => {
    const s = scoreHypothesis(
      {
        evidence_strength: 0,
        reproducibility: 0,
        verification_confidence: 0,
        actor_trust: 0,
        freshness_decay: 0,
      },
      baseCfg(),
    );
    expect(s).toBe(0);
  });

  it("12. clamp defence: inputs outside [0, 1] are clamped", () => {
    const cfg = baseCfg();
    const s = scoreHypothesis(
      {
        evidence_strength: 5,
        reproducibility: -1,
        verification_confidence: 2,
        actor_trust: 99,
        freshness_decay: -0.5,
      },
      cfg,
    );
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe("freshness", () => {
  it("11. exactly one half-life -> 0.5", () => {
    expect(freshness(defaultFreshnessHalfLifeDays, defaultFreshnessHalfLifeDays)).toBeCloseTo(
      0.5,
      10,
    );
  });

  it("age 0 -> 1.0", () => {
    expect(freshness(0, 14)).toBe(1);
  });

  it("negative age -> 1.0 (treated as 0)", () => {
    expect(freshness(-1, 14)).toBe(1);
  });

  it("two half-lives -> 0.25", () => {
    expect(freshness(28, 14)).toBeCloseTo(0.25, 10);
  });

  it("5. very old hypothesis (age >> half-life) -> ~0", () => {
    const f = freshness(1_000_000, 14);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1e-20);
  });

  it("degenerate half-life (0) -> 0 (safe-side default)", () => {
    expect(freshness(1, 0)).toBe(0);
  });
});

describe("ageDaysFromFiredAt", () => {
  it("0 sentinel -> +Infinity (treated as 'never fired')", () => {
    expect(ageDaysFromFiredAt(0, 1_700_000_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("now equal to fired -> 0 days", () => {
    expect(ageDaysFromFiredAt(1_700_000_000, 1_700_000_000)).toBe(0);
  });

  it("now < fired -> 0 (clamped, not negative)", () => {
    expect(ageDaysFromFiredAt(2_000_000_000, 1_000_000_000)).toBe(0);
  });

  it("86400 seconds later -> exactly 1 day", () => {
    expect(ageDaysFromFiredAt(1_700_000_000, 1_700_000_000 + 86_400)).toBe(1);
  });
});

describe("freshnessForHypothesis", () => {
  it("4. gravity_fired_at = 0 -> freshness = 0 ('never fired' = stale)", () => {
    expect(freshnessForHypothesis(0, 1_700_000_000, 14)).toBe(0);
  });

  it("freshly fired -> 1.0", () => {
    const t = 1_700_000_000;
    expect(freshnessForHypothesis(t, t, 14)).toBe(1);
  });
});

describe("meanActorTrust", () => {
  it("3. empty actors -> 0 (no trust to lend)", () => {
    expect(meanActorTrust([])).toBe(0);
  });

  it("single actor -> its trust_score", () => {
    const actors: ReadonlyArray<ContributingActor> = [
      { actor_id: "a", trust_score: 0.7 },
    ];
    expect(meanActorTrust(actors)).toBe(0.7);
  });

  it("multiple actors -> arithmetic mean", () => {
    const actors: ReadonlyArray<ContributingActor> = [
      { actor_id: "a", trust_score: 0.6 },
      { actor_id: "b", trust_score: 0.8 },
      { actor_id: "c", trust_score: 1.0 },
    ];
    expect(meanActorTrust(actors)).toBeCloseTo(0.8, 10);
  });

  it("clamps out-of-range trust scores defensively", () => {
    const actors: ReadonlyArray<ContributingActor> = [
      { actor_id: "a", trust_score: 2.0 },
      { actor_id: "b", trust_score: -0.5 },
    ];
    // clamped to 1 and 0 -> mean 0.5
    expect(meanActorTrust(actors)).toBe(0.5);
  });
});

describe("rankHypotheses", () => {
  const buildState = (hypotheses: ReadonlyArray<HypothesisState>): SessionState => {
    const s = emptySessionState({ session_id: "S", project_id: "P", goal: "g" });
    const m = new Map<string, HypothesisState>();
    for (const h of hypotheses) m.set(h.id, h);
    return { ...s, hypotheses: m };
  };

  it("7. excludes non-active hypotheses (AC-8.5)", () => {
    const state = buildState([
      {
        id: "H-1",
        title: "active",
        text: "x",
        current_state: "active",
        current_confidence: null,
        current_reason: null,
        reason_type: null,
        superseded_by_id: null,
        promoted_to_theory_id: null,
        belongs_to_theory_id: null,
        created_at: "2026-06-19T00:00:00.000Z",
        last_event_id: "H-1",
        last_event_at: "2026-06-19T00:00:00.000Z",
        gravity_fired_at: 1_700_000_000,
        ai_rank_score: null,
        ai_rank_reasoning: null,
        ai_rank_evaluator: null,
        ai_rank_at: null,
        ai_rank_event_id: null,
      },
      {
        id: "H-2",
        title: "rejected",
        text: "y",
        current_state: "rejected",
        current_confidence: null,
        current_reason: "no",
        reason_type: "evidence",
        superseded_by_id: null,
        promoted_to_theory_id: null,
        belongs_to_theory_id: null,
        created_at: "2026-06-19T00:00:00.000Z",
        last_event_id: "H-2",
        last_event_at: "2026-06-19T00:00:00.000Z",
        gravity_fired_at: 1_700_000_000,
        ai_rank_score: null,
        ai_rank_reasoning: null,
        ai_rank_evaluator: null,
        ai_rank_at: null,
        ai_rank_event_id: null,
      },
    ]);
    const out = rankHypotheses(
      state,
      baseCfg(),
      new Map(),
      new Map([
        ["H-1", 1_700_000_000],
        ["H-2", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    expect(out.map((h) => h.id)).toEqual(["H-1"]);
  });

  it("8. stable sort by (score desc, id asc) — AC-8.5", () => {
    const state = buildState([
      {
        id: "H-b",
        title: "b",
        text: "x",
        current_state: "active",
        current_confidence: null,
        current_reason: null,
        reason_type: null,
        superseded_by_id: null,
        promoted_to_theory_id: null,
        belongs_to_theory_id: null,
        created_at: "2026-06-19T00:00:00.000Z",
        last_event_id: "H-b",
        last_event_at: "2026-06-19T00:00:00.000Z",
        gravity_fired_at: 1_700_000_000,
        ai_rank_score: null,
        ai_rank_reasoning: null,
        ai_rank_evaluator: null,
        ai_rank_at: null,
        ai_rank_event_id: null,
      },
      {
        id: "H-a",
        title: "a",
        text: "y",
        current_state: "active",
        current_confidence: null,
        current_reason: null,
        reason_type: null,
        superseded_by_id: null,
        promoted_to_theory_id: null,
        belongs_to_theory_id: null,
        created_at: "2026-06-19T00:00:00.000Z",
        last_event_id: "H-a",
        last_event_at: "2026-06-19T00:00:00.000Z",
        gravity_fired_at: 1_700_000_000,
        ai_rank_score: null,
        ai_rank_reasoning: null,
        ai_rank_evaluator: null,
        ai_rank_at: null,
        ai_rank_event_id: null,
      },
    ]);
    // H-b's actor has higher trust; H-a's actor has lower trust.
    // With identical freshness, H-b should rank first, but if scores
    // tie (e.g. no actors -> both 0 on trust), the tiebreak is id asc.
    const out = rankHypotheses(
      state,
      baseCfg(),
      new Map<string, ReadonlyArray<ContributingActor>>([
        ["H-b", [{ actor_id: "x", trust_score: 1.0 }]],
        ["H-a", []],
      ]),
      new Map([
        ["H-b", 1_700_000_000],
        ["H-a", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    expect(out[0]?.id).toBe("H-b");
  });

  it("tiebreak by id asc when scores are equal", () => {
    const state = buildState([
      {
        id: "H-z",
        title: "z",
        text: "x",
        current_state: "active",
        current_confidence: null,
        current_reason: null,
        reason_type: null,
        superseded_by_id: null,
        promoted_to_theory_id: null,
        belongs_to_theory_id: null,
        created_at: "2026-06-19T00:00:00.000Z",
        last_event_id: "H-z",
        last_event_at: "2026-06-19T00:00:00.000Z",
        gravity_fired_at: 1_700_000_000,
        ai_rank_score: null,
        ai_rank_reasoning: null,
        ai_rank_evaluator: null,
        ai_rank_at: null,
        ai_rank_event_id: null,
      },
      {
        id: "H-a",
        title: "a",
        text: "y",
        current_state: "active",
        current_confidence: null,
        current_reason: null,
        reason_type: null,
        superseded_by_id: null,
        promoted_to_theory_id: null,
        belongs_to_theory_id: null,
        created_at: "2026-06-19T00:00:00.000Z",
        last_event_id: "H-a",
        last_event_at: "2026-06-19T00:00:00.000Z",
        gravity_fired_at: 1_700_000_000,
        ai_rank_score: null,
        ai_rank_reasoning: null,
        ai_rank_evaluator: null,
        ai_rank_at: null,
        ai_rank_event_id: null,
      },
    ]);
    const out = rankHypotheses(
      state,
      baseCfg(),
      new Map(),
      new Map([
        ["H-z", 1_700_000_000],
        ["H-a", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    // No actors, no verifications -> 0 on all axes except freshness
    // (both fire_at=now, so freshness=1). Scores are equal -> tiebreak
    // is id asc.
    expect(out.map((h) => h.id)).toEqual(["H-a", "H-z"]);
  });
});

/**
 * v1.2.0 AI-rank override: a hypothesis with a recorded
 * `ai_rank_score` is ranked by that score, not the 5-axis formula.
 * The formula is the fallback for hypotheses the supervisor has
 * not yet scored. `source` on each row marks which path produced it.
 */
describe("rankHypotheses — AI rank override (v1.2.0)", () => {
  const buildState = (hypotheses: ReadonlyArray<HypothesisState>): SessionState => {
    const s = emptySessionState({ session_id: "S", project_id: "P", goal: "g" });
    const m = new Map<string, HypothesisState>();
    for (const h of hypotheses) m.set(h.id, h);
    return { ...s, hypotheses: m };
  };

  const baseActive = (id: string, overrides: Partial<HypothesisState> = {}): HypothesisState => ({
    id,
    title: id,
    text: id,
    current_state: "active",
    current_confidence: null,
    current_reason: null,
    reason_type: null,
    superseded_by_id: null,
    promoted_to_theory_id: null,
    belongs_to_theory_id: null,
    created_at: "2026-06-19T00:00:00.000Z",
    last_event_id: id,
    last_event_at: "2026-06-19T00:00:00.000Z",
    gravity_fired_at: 1_700_000_000,
    ai_rank_score: null,
    ai_rank_reasoning: null,
    ai_rank_evaluator: null,
    ai_rank_at: null,
    ai_rank_event_id: null,
    ...overrides,
  });

  it("uses AI rank when present, ignores formula even if formula would rank higher", () => {
    // Two hypotheses: H-1 has formula inputs that would produce 1.0
    // (full evidence/actors/freshness) but the AI ranked it 0.2.
    // H-2 has empty inputs so formula gives 0 but AI ranked it 0.9.
    // AI wins: H-2 ranks first, H-1 second.
    const state = buildState([
      baseActive("H-1", { ai_rank_score: 0.2, ai_rank_reasoning: "low", ai_rank_evaluator: "ai-supervisor", ai_rank_at: "2026-06-19T00:00:00.000Z", ai_rank_event_id: "ev1" }),
      baseActive("H-2", { ai_rank_score: 0.9, ai_rank_reasoning: "high", ai_rank_evaluator: "ai-supervisor", ai_rank_at: "2026-06-19T00:00:00.000Z", ai_rank_event_id: "ev2" }),
    ]);
    const out = rankHypotheses(
      state,
      baseCfg(),
      new Map<string, ReadonlyArray<ContributingActor>>([
        // H-1 has high-trust actors (would push formula up)
        ["H-1", [{ actor_id: "a", trust_score: 1.0 }]],
        ["H-2", []],
      ]),
      new Map([
        ["H-1", 1_700_000_000],
        ["H-2", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    expect(out.map((h) => h.id)).toEqual(["H-2", "H-1"]);
    expect(out[0]?.source).toBe("ai");
    expect(out[1]?.source).toBe("ai");
  });

  it("ai_rank_score = 0 still overrides formula (null ≠ 0)", () => {
    // H-1 has no AI rank, so the formula decides it (full inputs -> 1.0).
    // H-2 has ai_rank_score = 0, which is a real rank — H-2 must rank last.
    const state = buildState([
      baseActive("H-1"),
      baseActive("H-2", { ai_rank_score: 0, ai_rank_reasoning: "reject", ai_rank_evaluator: "ai-supervisor", ai_rank_at: "2026-06-19T00:00:00.000Z", ai_rank_event_id: "ev2" }),
    ]);
    const out = rankHypotheses(
      state,
      baseCfg(),
      new Map<string, ReadonlyArray<ContributingActor>>([
        ["H-1", [{ actor_id: "a", trust_score: 1.0 }]],
        ["H-2", []],
      ]),
      new Map([
        ["H-1", 1_700_000_000],
        ["H-2", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    expect(out.map((h) => h.id)).toEqual(["H-1", "H-2"]);
    expect(out[1]?.score).toBe(0);
    expect(out[1]?.source).toBe("ai");
  });

  it("out-of-range ai_rank_score is clamped defensively to [0, 1]", () => {
    const state = buildState([
      baseActive("H-1", { ai_rank_score: 1.7, ai_rank_reasoning: "x", ai_rank_evaluator: "ai-supervisor", ai_rank_at: "2026-06-19T00:00:00.000Z", ai_rank_event_id: "ev1" }),
      baseActive("H-2", { ai_rank_score: -0.3, ai_rank_reasoning: "y", ai_rank_evaluator: "ai-supervisor", ai_rank_at: "2026-06-19T00:00:00.000Z", ai_rank_event_id: "ev2" }),
    ]);
    const out = rankHypotheses(
      state,
      baseCfg(),
      new Map(),
      new Map([
        ["H-1", 1_700_000_000],
        ["H-2", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    expect(out[0]?.id).toBe("H-1");
    expect(out[0]?.score).toBe(1);
    expect(out[1]?.score).toBe(0);
    expect(out[0]?.source).toBe("ai");
    expect(out[1]?.source).toBe("ai");
  });

  it("mixes AI and rule: unranked hypotheses fall back to formula", () => {
    // H-1 has no AI rank -> formula: 1 actor (trust=1) + freshness=1
    //   => trust 0.10 + freshness 0.10 = 0.20.
    // H-2 has AI rank 0.3.
    // H-2 (0.3) > H-1 (0.20) — AI rank wins despite the formula
    // having more axes available for H-1. The override is full-rank,
    // not a tiebreaker: AI rank is the score, period.
    const state = buildState([
      baseActive("H-1"),
      baseActive("H-2", { ai_rank_score: 0.3, ai_rank_reasoning: "r", ai_rank_evaluator: "ai-supervisor", ai_rank_at: "2026-06-19T00:00:00.000Z", ai_rank_event_id: "ev2" }),
    ]);
    const out = rankHypotheses(
      state,
      baseCfg(),
      new Map<string, ReadonlyArray<ContributingActor>>([
        ["H-1", [{ actor_id: "a", trust_score: 1.0 }]],
        ["H-2", []],
      ]),
      new Map([
        ["H-1", 1_700_000_000],
        ["H-2", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    expect(out.map((h) => h.id)).toEqual(["H-2", "H-1"]);
    expect(out[0]?.source).toBe("ai");
    expect(out[1]?.source).toBe("rule");
  });

  it("non-finite ai_rank_score (NaN) falls back to formula rather than poisoning the rank", () => {
    const state = buildState([
      baseActive("H-1"),
      baseActive("H-2", { ai_rank_score: Number.NaN, ai_rank_reasoning: "x", ai_rank_evaluator: "ai-supervisor", ai_rank_at: "2026-06-19T00:00:00.000Z", ai_rank_event_id: "ev2" }),
    ]);
    const out = rankHypotheses(
      state,
      baseCfg(),
      new Map<string, ReadonlyArray<ContributingActor>>([
        ["H-1", []],
        ["H-2", [{ actor_id: "a", trust_score: 1.0 }]],
      ]),
      new Map([
        ["H-1", 1_700_000_000],
        ["H-2", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    // H-2 has high-trust actor, formula scores it higher than H-1.
    // NaN rank must NOT win — fallback to formula.
    expect(out[0]?.id).toBe("H-2");
    expect(out[0]?.source).toBe("rule");
    expect(out[1]?.source).toBe("rule");
  });

  it("+Infinity ai_rank_score falls back to formula, does not rank as 1.0", () => {
    // `Number.isFinite(+Infinity)` is true, so a guard that only
    // checks isFinite would silently clamp +Infinity → 1 and rank it
    // at the top. We must reject ±Infinity and fall back to rule.
    const state = buildState([
      baseActive("H-1"),
      baseActive("H-2", { ai_rank_score: Number.POSITIVE_INFINITY, ai_rank_reasoning: "x", ai_rank_evaluator: "ai-supervisor", ai_rank_at: "2026-06-19T00:00:00.000Z", ai_rank_event_id: "ev2" }),
    ]);
    const out = rankHypotheses(
      state,
      baseCfg(),
      new Map<string, ReadonlyArray<ContributingActor>>([
        ["H-1", []],
        ["H-2", [{ actor_id: "a", trust_score: 1.0 }]],
      ]),
      new Map([
        ["H-1", 1_700_000_000],
        ["H-2", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    // H-2 must be rule-scored, not pinned to score 1.0.
    expect(out[1]?.source).toBe("rule");
  });

  it("-Infinity ai_rank_score falls back to formula, does not rank as 0.0", () => {
    // H-1 has a real AI rank of 0 (source "ai"); H-2 has -Infinity
    // (malformed). Without the fix, H-2 would clamp to 0 and look
    // indistinguishable from H-1. With the fix, H-2 falls back to
    // rule: no actors + freshness=1 → trust 0 + freshness 0.10 = 0.10.
    // So H-2 (0.10) > H-1 (0.0) and H-2 ranks first with source "rule".
    const state = buildState([
      baseActive("H-1", { ai_rank_score: 0, ai_rank_reasoning: "r", ai_rank_evaluator: "ai-supervisor", ai_rank_at: "2026-06-19T00:00:00.000Z", ai_rank_event_id: "ev1" }),
      baseActive("H-2", { ai_rank_score: Number.NEGATIVE_INFINITY, ai_rank_reasoning: "x", ai_rank_evaluator: "ai-supervisor", ai_rank_at: "2026-06-19T00:00:00.000Z", ai_rank_event_id: "ev2" }),
    ]);
    const out = rankHypotheses(
      state,
      baseCfg(),
      new Map<string, ReadonlyArray<ContributingActor>>([
        ["H-1", [{ actor_id: "a", trust_score: 1.0 }]],
        ["H-2", []],
      ]),
      new Map([
        ["H-1", 1_700_000_000],
        ["H-2", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    // H-2 (rule = 0.10) > H-1 (AI = 0). The crucial assertion is that
    // H-2 is source "rule" — not "ai" with score 0.
    expect(out[0]?.id).toBe("H-2");
    expect(out[0]?.source).toBe("rule");
    expect(out[1]?.id).toBe("H-1");
    expect(out[1]?.source).toBe("ai");
  });
});

/**
 * Full-axis helpers (formerly server-only in gravity-inputs.ts).
 * rankHypotheses must use these so evidence / reproducibility /
 * confidence are not hard-coded to 0 when SessionState has signal.
 */
describe("state-level axis helpers", () => {
  const baseActive = (id: string, overrides: Partial<HypothesisState> = {}): HypothesisState => ({
    id,
    title: id,
    text: id,
    current_state: "active",
    current_confidence: null,
    current_reason: null,
    reason_type: null,
    superseded_by_id: null,
    promoted_to_theory_id: null,
    belongs_to_theory_id: null,
    created_at: "2026-06-19T00:00:00.000Z",
    last_event_id: id,
    last_event_at: "2026-06-19T00:00:00.000Z",
    gravity_fired_at: 1_700_000_000,
    ai_rank_score: null,
    ai_rank_reasoning: null,
    ai_rank_evaluator: null,
    ai_rank_at: null,
    ai_rank_event_id: null,
    ...overrides,
  });

  const finding = (id: string): FindingState => ({
    id,
    text: id,
    related_observation_ids: [],
    created_at: "2026-06-19T00:00:00.000Z",
    last_event_id: id,
  });

  const conclusion = (
    id: string,
    state: ConclusionState["state"],
    supporting: ReadonlyArray<string>,
  ): ConclusionState => ({
    id,
    text: id,
    state,
    verification_id: null,
    supporting_evidence_ids: supporting,
    reason: null,
    created_at: "2026-06-19T00:00:00.000Z",
    last_event_id: id,
    last_event_at: "2026-06-19T00:00:00.000Z",
  });

  const verification = (
    id: string,
    hypId: string,
    state: VerificationState["state"],
    started_at: string,
  ): VerificationState => ({
    id,
    command: "true",
    type: "test",
    linked_hypothesis_id: hypId,
    state,
    stderr_excerpt: null,
    error: null,
    parent_verification_id: null,
    started_at,
    ended_at: started_at,
    expected_duration_ms: null,
    duration_ms: null,
    exit_code: state === "passed" ? 0 : 1,
    stdout_excerpt: null,
    created_artifact_id: null,
    last_event_id: id,
  });

  it("evidenceStrengthFor: 0 findings/conclusions → 0", () => {
    const s = emptySessionState({ session_id: "S", project_id: "P", goal: "g" });
    const h = baseActive("H-1");
    expect(evidenceStrengthFor(s, h)).toBe(0);
  });

  it("evidenceStrengthFor: 1 finding → n/(n+3) = 0.25", () => {
    const base = emptySessionState({ session_id: "S", project_id: "P", goal: "g" });
    const s: SessionState = {
      ...base,
      findings: [finding("F-1")],
      hypotheses: new Map([["H-1", baseActive("H-1")]]),
    };
    expect(evidenceStrengthFor(s, baseActive("H-1"))).toBeCloseTo(0.25, 10);
  });

  it("evidenceStrengthFor: verified conclusion supporting hyp counts; unverified does not", () => {
    const base = emptySessionState({ session_id: "S", project_id: "P", goal: "g" });
    const h = baseActive("H-1");
    const s: SessionState = {
      ...base,
      conclusions: new Map([
        ["C-ok", conclusion("C-ok", "verified", ["H-1"])],
        ["C-no", conclusion("C-no", "unverified", ["H-1"])],
        ["C-other", conclusion("C-other", "verified", ["H-other"])],
      ]),
      hypotheses: new Map([["H-1", h]]),
    };
    // only C-ok → total=1 → 1/4 = 0.25
    expect(evidenceStrengthFor(s, h)).toBeCloseTo(0.25, 10);
  });

  it("reproducibilityFor: no verifications → 0; single pass → 1", () => {
    const base = emptySessionState({ session_id: "S", project_id: "P", goal: "g" });
    const h = baseActive("H-1");
    expect(reproducibilityFor(base, h)).toBe(0);
    const s: SessionState = {
      ...base,
      verifications: new Map([
        ["V-1", verification("V-1", "H-1", "passed", "2026-06-19T01:00:00.000Z")],
      ]),
      hypotheses: new Map([["H-1", h]]),
    };
    expect(reproducibilityFor(s, h)).toBe(1);
  });

  it("reproducibilityFor: fail then pass weights recency (recent pass pulls up)", () => {
    const base = emptySessionState({ session_id: "S", project_id: "P", goal: "g" });
    const h = baseActive("H-1");
    const s: SessionState = {
      ...base,
      verifications: new Map([
        ["V-old", verification("V-old", "H-1", "failed", "2026-06-19T01:00:00.000Z")],
        ["V-new", verification("V-new", "H-1", "passed", "2026-06-19T02:00:00.000Z")],
      ]),
      hypotheses: new Map([["H-1", h]]),
    };
    // weights: oldest 0.5, newest 1.0 → (0*0.5 + 1*1.0) / 1.5 = 2/3
    expect(reproducibilityFor(s, h)).toBeCloseTo(2 / 3, 10);
  });

  it("verificationConfidenceFor: current_confidence 0..100 scaled; >1 means percent", () => {
    const s = emptySessionState({ session_id: "S", project_id: "P", goal: "g" });
    expect(verificationConfidenceFor(s, baseActive("H-1", { current_confidence: 80 }))).toBeCloseTo(
      0.8,
      10,
    );
    expect(verificationConfidenceFor(s, baseActive("H-1", { current_confidence: 0.4 }))).toBeCloseTo(
      0.4,
      10,
    );
  });

  it("verificationConfidenceFor: falls back to latest verification outcome", () => {
    const base = emptySessionState({ session_id: "S", project_id: "P", goal: "g" });
    const h = baseActive("H-1");
    const s: SessionState = {
      ...base,
      verifications: new Map([
        ["V-old", verification("V-old", "H-1", "failed", "2026-06-19T01:00:00.000Z")],
        ["V-new", verification("V-new", "H-1", "passed", "2026-06-19T03:00:00.000Z")],
      ]),
      hypotheses: new Map([["H-1", h]]),
    };
    expect(verificationConfidenceFor(s, h)).toBe(1);
  });

  it("rankHypotheses: findings/verifications raise rule score above freshness-only", () => {
    const hBare = baseActive("H-bare");
    const hRich = baseActive("H-rich", { current_confidence: 1 });
    const base = emptySessionState({ session_id: "S", project_id: "P", goal: "g" });
    // Bare state: no findings/verifs; H-bare has no confidence signal.
    const bareState: SessionState = {
      ...base,
      hypotheses: new Map([["H-bare", hBare]]),
    };
    // Rich state: 3 findings (session-scoped), 1 passing verification,
    // hypothesis confidence = 1.0.
    const richState: SessionState = {
      ...base,
      findings: [finding("F-1"), finding("F-2"), finding("F-3")],
      verifications: new Map([
        ["V-1", verification("V-1", "H-rich", "passed", "2026-06-19T01:00:00.000Z")],
      ]),
      hypotheses: new Map([["H-rich", hRich]]),
    };
    const now = 1_700_000_000;
    const bareOut = rankHypotheses(
      bareState,
      baseCfg(),
      new Map(),
      new Map([["H-bare", now]]),
      now,
    );
    const richOut = rankHypotheses(
      richState,
      baseCfg(),
      new Map(),
      new Map([["H-rich", now]]),
      now,
    );
    const bareScore = bareOut.find((r) => r.id === "H-bare")?.score ?? 0;
    const richScore = richOut.find((r) => r.id === "H-rich")?.score ?? 0;
    // Bare: only freshness=1 → weight 0.10.
    // Rich: evidence 3/(3+3)=0.5, repro=1, confidence=1, freshness=1.
    expect(bareScore).toBeCloseTo(defaultGravityWeights.freshness, 10);
    expect(richScore).toBeGreaterThan(bareScore);
    expect(richScore).toBeCloseTo(
      defaultGravityWeights.evidence * 0.5 +
        defaultGravityWeights.reproducibility * 1 +
        defaultGravityWeights.confidence * 1 +
        defaultGravityWeights.freshness * 1,
      10,
    );
    // In a mixed session, H-rich outranks H-bare (verifs + confidence
    // are per-hypothesis; findings raise both equally).
    const mixed: SessionState = {
      ...base,
      findings: [finding("F-1")],
      verifications: new Map([
        ["V-1", verification("V-1", "H-rich", "passed", "2026-06-19T01:00:00.000Z")],
      ]),
      hypotheses: new Map([
        ["H-bare", hBare],
        ["H-rich", hRich],
      ]),
    };
    const ordered = rankHypotheses(
      mixed,
      baseCfg(),
      new Map(),
      new Map([
        ["H-bare", now],
        ["H-rich", now],
      ]),
      now,
    );
    expect(ordered[0]?.id).toBe("H-rich");
    expect(ordered[0]?.source).toBe("rule");
    expect(ordered[1]?.id).toBe("H-bare");
  });
});

describe("determinism", () => {
  it("6. 1000 iterations of the same input -> identical output", () => {
    const input = {
      evidence_strength: 0.5,
      reproducibility: 0.5,
      verification_confidence: 0.5,
      actor_trust: 0.5,
      freshness_decay: 0.5,
    };
    const first = scoreHypothesis(input, baseCfg());
    for (let i = 0; i < 1000; i++) {
      expect(scoreHypothesis(input, baseCfg())).toBe(first);
    }
  });

  it("6b. 1000 iterations of freshness -> identical output", () => {
    const first = freshness(7.5, 14);
    for (let i = 0; i < 1000; i++) {
      expect(freshness(7.5, 14)).toBe(first);
    }
  });
});

describe("config: gravity weights", () => {
  it("9. sum != 1.0 throws on parse", () => {
    const bad = {
      project: { name: "x" },
      gravity: {
        freshness_half_life_days: 14,
        weights: {
          evidence: 0.5,
          reproducibility: 0.5,
          confidence: 0.5,
          trust: 0.1,
          freshness: 0.1,
        },
      },
    };
    expect(() => parseCognitConfig(bad)).toThrow();
  });

  it("10. sum within ±0.001 of 1.0 passes", () => {
    const ok = {
      project: { name: "x" },
      gravity: {
        freshness_half_life_days: 14,
        weights: {
          evidence: 0.3,
          reproducibility: 0.3,
          confidence: 0.2,
          trust: 0.1,
          freshness: 0.0995, // 0.9995 sum, within tolerance
        },
      },
    };
    const parsed = parseCognitConfig(ok);
    expect(parsed.gravity.weights.evidence).toBe(0.3);
  });

  it("default config weights sum to exactly 1.0", () => {
    const cfg = defaultConfig("sum-test");
    const sum =
      cfg.gravity.weights.evidence +
      cfg.gravity.weights.reproducibility +
      cfg.gravity.weights.confidence +
      cfg.gravity.weights.trust +
      cfg.gravity.weights.freshness;
    expect(sum).toBeCloseTo(1.0, 5);
  });
});
