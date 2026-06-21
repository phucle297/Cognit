/**
 * packages/gravity/src/scoring.ts — phase 8 v0.2 gravity engine.
 *
 * Pure, deterministic, total. No I/O. No Effect. No DB. The caller
 * resolves the SessionState, contributing actors, and config; this
 * module maps them to a real number in [0, 1].
 *
 * 5 inputs, all in [0, 1]:
 *   - evidence_strength         (count of supporting findings / conclusions)
 *   - reproducibility           (passed verifications × recency)
 *   - verification_confidence   (latest exit signal)
 *   - actor_trust               (mean of contributing actors' trust_score)
 *   - freshness_decay           (half-life decay from gravity_fired_at)
 *
 * Weights are configurable via `cognit.yaml` `gravity.weights.*` —
 * default: {evidence: 0.30, reproducibility: 0.30, confidence: 0.20,
 * trust: 0.10, freshness: 0.10}. The config schema (in
 * `@cognit/core/config.ts`) validates the sum to within ±0.001 of 1.0
 * on parse.
 *
 * Freshness function: 0.5 ** (age_days / half_life_days). When
 * `gravity_fired_at = 0` (i.e. the hypothesis was created in v0.1
 * before the column was added and never re-fired), we treat the
 * hypothesis as "never fired" and return `freshness = 0` — i.e. it
 * is considered stale, which makes the gravity score decay to 0 in
 * the freshness dimension. This is the safe default; callers wanting
 * "treat never-fired as 1.0" can pass an explicit `freshness_override`
 * via the input.
 *
 * The `gravity_fired_at` timestamp is recorded in epoch seconds (REAL
 * column) to keep it sortable and free of timezone / ISO parsing
 * issues in pure functions. The reducer backfills it on insert; the
 * constraint engine updates it whenever a mutation action fires.
 *
 * Determinism: same input → same output, every call. No `Math.random`,
 * no `Date.now`, no environment lookups. Tests assert this property
 * (1000 iterations).
 */
import type { CognitConfig } from "@cognit/core/config";
import type {
  HypothesisState,
  SessionState,
} from "@cognit/core/state";

/** Default weights from plan §Open decisions #3 (resolved 2026-06-19). */
export const defaultGravityWeights: Readonly<GravityWeights> = {
  evidence: 0.30,
  reproducibility: 0.30,
  confidence: 0.20,
  trust: 0.10,
  freshness: 0.10,
};

/** Default half-life in days, plan §Open decisions #4. */
export const defaultFreshnessHalfLifeDays = 14;

/** Per-axis weights. Sum must be within ±0.001 of 1.0 (validated on parse). */
export interface GravityWeights {
  readonly evidence: number;
  readonly reproducibility: number;
  readonly confidence: number;
  readonly trust: number;
  readonly freshness: number;
}

/**
 * A contributing actor — one row in the `contributingActors` selector
 * (joins `events` + `actors` for events that touch the given
 * hypothesis). `trust_score` is on [0, 1].
 */
export interface ContributingActor {
  readonly actor_id: string;
  readonly trust_score: number;
}

/** 5-axis input to `scoreHypothesis`. All axes in [0, 1]. */
export interface GravityScoreInput {
  readonly evidence_strength: number;
  readonly reproducibility: number;
  readonly verification_confidence: number;
  readonly actor_trust: number;
  readonly freshness_decay: number;
}

/**
 * A hypothesis that has been ranked by `rankHypotheses`.
 *
 * `source` is `"ai"` when the score came from a v1.2.0
 * `hypothesis_ranked` event (the AI supervisor's rank wins, per the
 * override rule), and `"rule"` when the 5-axis formula produced it
 * because no AI rank has been recorded yet.
 */
export interface RankedHypothesis {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly score: number;
  readonly source: "ai" | "rule";
}

/**
 * Half-life freshness decay. Returns 1.0 when age is 0, 0.5 at
 * one half-life, 0.25 at two, etc. When half-life is non-positive,
 * returns 0 (degenerate config — the schema validator should
 * prevent this, but the scoring fn defends against it).
 */
export const freshness = (ageDays: number, halfLifeDays: number): number => {
  if (halfLifeDays <= 0) return 0;
  if (ageDays <= 0) return 1;
  return 0.5 ** (ageDays / halfLifeDays);
};

/** Clamp a number to the closed interval [lo, hi]. */
const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n;

/**
 * Compute the gravity score for a single hypothesis. Pure,
 * deterministic. Returns a real number in [0, 1].
 *
 * `cfg.gravity.weights` and `cfg.gravity.freshness_half_life_days`
 * are read from the typed `CognitConfig`; the schema already
 * validated that the weights sum to within ±0.001 of 1.0 at parse
 * time. We clamp the final sum to [0, 1] defensively in case
 * floating-point drift pushes the result slightly out of range.
 */
export const scoreHypothesis = (
  input: GravityScoreInput,
  cfg: Pick<CognitConfig, "gravity">,
): number => {
  const w = cfg.gravity.weights;
  const raw =
    w.evidence * input.evidence_strength +
    w.reproducibility * input.reproducibility +
    w.confidence * input.verification_confidence +
    w.trust * input.actor_trust +
    w.freshness * input.freshness_decay;
  return clamp(raw, 0, 1);
};

/**
 * Compute `age_days` from a `gravity_fired_at` value (epoch seconds,
 * REAL column) and a `now` epoch-seconds value. Returns 0 for the
 * sentinel `0` (never fired). The `now` parameter is part of the
 * input — callers pass `Date.now() / 1000` and tests can pin it.
 */
export const ageDaysFromFiredAt = (firedAt: number, nowSec: number): number => {
  if (firedAt === 0) return Number.POSITIVE_INFINITY;
  if (nowSec <= firedAt) return 0;
  return (nowSec - firedAt) / 86_400;
};

/**
 * Mean trust across the contributing actors for a hypothesis.
 * Returns 0 when there are no actors (a hypothesis with no events
 * has no trust to lend — matches the "neutral" default). Bounds
 * the result to [0, 1] defensively.
 */
export const meanActorTrust = (actors: ReadonlyArray<ContributingActor>): number => {
  if (actors.length === 0) return 0;
  let sum = 0;
  for (const a of actors) sum += clamp(a.trust_score, 0, 1);
  return clamp(sum / actors.length, 0, 1);
};

/**
 * Build the freshness value for a hypothesis given its
 * `gravity_fired_at` (epoch seconds) and the current time (epoch
 * seconds). Uses the half-life from `cfg.gravity`. The `0` sentinel
 * (never fired) maps to 0 — treated as stale, per the documented
 * rule in the module header.
 */
export const freshnessForHypothesis = (
  firedAt: number,
  nowSec: number,
  halfLifeDays: number,
): number => {
  const ageDays = ageDaysFromFiredAt(firedAt, nowSec);
  if (!Number.isFinite(ageDays)) return 0;
  return freshness(ageDays, halfLifeDays);
};

/**
 * Rank all ACTIVE hypotheses in a session by their gravity score.
 * Stable sort: score DESC, then hypothesis id ASC. Hypotheses
 * with `state !== "active"` are excluded (AC-8.5).
 *
 * v1.2.0 AI-rank override: when a hypothesis carries an
 * `ai_rank_score` (emitted by an `hypothesis_ranked` event from the
 * AI supervisor), that score REPLACES the 5-axis formula result for
 * this ranking. The rule-based score becomes a fallback used only
 * for hypotheses the AI has not yet scored. This matches the plan
 * design where AI judgement is authoritative and the formula is
 * the default until the supervisor has had a turn.
 *
 * `contributingActorsByHypothesis` is a map from hypothesis id to
 * the list of contributing actors (built by
 * `@cognit/db/gravity.contributingActors`). `firedAtByHypothesis`
 * is a map from hypothesis id to the `gravity_fired_at` value
 * (epoch seconds). `nowSec` is the current time in epoch seconds.
 *
 * The fn is pure — no Date.now fallback. The caller passes
 * `nowSec`; tests can pin it.
 */
export const rankHypotheses = (
  state: SessionState,
  cfg: Pick<CognitConfig, "gravity">,
  contributingActorsByHypothesis: ReadonlyMap<string, ReadonlyArray<ContributingActor>>,
  firedAtByHypothesis: ReadonlyMap<string, number>,
  nowSec: number,
): ReadonlyArray<RankedHypothesis> => {
  const halfLife = cfg.gravity.freshness_half_life_days;
  const entries: Array<{ h: HypothesisState; score: number; source: "ai" | "rule" }> = [];
  for (const h of state.hypotheses.values()) {
    if (h.current_state !== "active") continue;
    // AI-rank override: if the supervisor has recorded a score for
    // this hypothesis, that score is authoritative. We clamp defensively
    // (the schema already enforces [0,1], but stale or out-of-range
    // data should never break ranking).
    const aiRank = h.ai_rank_score;
    if (aiRank !== null && Number.isFinite(aiRank)) {
      entries.push({ h, score: clamp(aiRank, 0, 1), source: "ai" });
      continue;
    }
    const actors = contributingActorsByHypothesis.get(h.id) ?? [];
    const firedAt = firedAtByHypothesis.get(h.id) ?? 0;
    const score = scoreHypothesis(
      {
        evidence_strength: 0, // wired by phase 8g.4 (needs state-level selector)
        reproducibility: 0,
        verification_confidence: 0,
        actor_trust: meanActorTrust(actors),
        freshness_decay: freshnessForHypothesis(firedAt, nowSec, halfLife),
      },
      cfg,
    );
    entries.push({ h, score, source: "rule" });
  }
  // Stable sort: score DESC, then id ASC.
  entries.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.h.id < b.h.id) return -1;
    if (a.h.id > b.h.id) return 1;
    return 0;
  });
  return entries.map(({ h, score, source }) => ({
    id: h.id,
    title: h.title,
    text: h.text,
    score,
    source,
  }));
};
