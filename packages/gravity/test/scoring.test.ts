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
 */
import { describe, it, expect } from "vitest";
import { defaultConfig, parseCognitConfig } from "@cognit/core/config";
import {
  emptySessionState,
  type HypothesisState,
  type SessionState,
} from "@cognit/core/state";
import {
  ageDaysFromFiredAt,
  defaultFreshnessHalfLifeDays,
  defaultGravityWeights,
  freshness,
  freshnessForHypothesis,
  meanActorTrust,
  rankHypotheses,
  scoreHypothesis,
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
