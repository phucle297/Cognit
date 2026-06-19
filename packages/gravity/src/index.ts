/**
 * @cognit/gravity — phase 8 v0.2 gravity engine.
 *
 * Public surface:
 *   - `scoreHypothesis(input, cfg)` — pure function: 5 weighted inputs →
 *     number in [0,1].
 *   - `defaultGravityWeights` — the spec weights
 *     {evidence:0.30, reproducibility:0.30, confidence:0.20,
 *      trust:0.10, freshness:0.10}.
 *   - `defaultFreshnessHalfLifeDays` — 14.
 *   - `freshness(ageDays, halfLifeDays)` — half-life decay: 0.5 ** (age / halfLife).
 *   - `rankHypotheses(state, cfg, contributingActorsById)` — stable-sort
 *     active hypotheses by (score desc, id asc).
 *
 * The package never depends on `@cognit/server` or `@cognit/dashboard`.
 * It does depend on `@cognit/core` for the typed `CognitConfig` shape.
 */
export {
  scoreHypothesis,
  freshness,
  defaultFreshnessHalfLifeDays,
  defaultGravityWeights,
  rankHypotheses,
  type GravityScoreInput,
  type GravityWeights,
  type RankedHypothesis,
  type ContributingActor,
} from "./scoring.js";
