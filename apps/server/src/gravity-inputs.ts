/**
 * apps/server/src/gravity-inputs.ts — thin re-export of
 * `@cognit/gravity` ranking for server routes.
 *
 * Ranking (evidence / reproducibility / verification_confidence /
 * actor_trust / freshness, plus AI-rank override) lives in
 * `packages/gravity/src/scoring.ts`. This module keeps the historical
 * import path `rankActiveHypothesesFromState` and the server-local
 * `DEFAULT_GRAVITY_CFG` used when routes cannot read `cognit.yaml`.
 *
 * Pure, deterministic, no I/O. Tests pin `nowSec` for stable scores.
 */
import type { CognitConfig } from "@cognit/core/config";
import { rankHypotheses } from "@cognit/gravity";

/**
 * Rank active hypotheses via the unified gravity scorer.
 * Alias of `@cognit/gravity.rankHypotheses` — same signature and
 * behaviour (full 5-axis formula + AI-rank override + stable sort).
 */
export const rankActiveHypothesesFromState = rankHypotheses;

/**
 * Default gravity config used when the route can't read
 * `cognit.yaml` (tests, missing config, etc.). Mirrors the schema
 * defaults in `@cognit/core/config.ts`.
 */
export const DEFAULT_GRAVITY_CFG: Pick<CognitConfig, "gravity"> = {
  gravity: {
    freshness_half_life_days: 14,
    weights: {
      evidence: 0.3,
      reproducibility: 0.3,
      confidence: 0.2,
      trust: 0.1,
      freshness: 0.1,
    },
  },
};
