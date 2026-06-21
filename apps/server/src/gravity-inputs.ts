/**
 * apps/server/src/gravity-inputs.ts — phase 8 (8g.4).
 *
 * Pure builder: given a SessionState + the per-hypothesis maps the
 * route resolved (`contributingActors`, `firedAt`), produce the
 * ranked list of active hypotheses via
 * `@cognit/gravity.rankHypotheses` *with state-level evidence /
 * reproducibility / verification_confidence inputs filled*.
 *
 * `rankHypotheses` in `@cognit/gravity` hard-codes those three
 * axes to 0 because the package doesn't import SessionState's
 * verifications/findings/conclusions readers. This module folds
 * those signals out of state and re-scores the same set so the
 * scorer is full-band, not freshness-only.
 *
 * Pure, deterministic, no I/O. Tests pin `nowSec` for stable scores.
 */
import type { CognitConfig } from "@cognit/core/config";
import type {
  HypothesisState,
  SessionState,
  VerificationState,
} from "@cognit/core/state";
import {
  freshnessForHypothesis,
  meanActorTrust,
  scoreHypothesis,
  type ContributingActor,
  type RankedHypothesis,
} from "@cognit/gravity";

/**
 * Count of distinct findings + verified conclusions that supply
 * evidence to this hypothesis, normalised to [0, 1] via a
 * monotonic saturation curve. We use `n / (n + k)` with `k=3` so
 * 0 → 0, 1 → 0.25, 3 → 0.5, 9 → 0.75 — the score asymptotes to 1
 * without ever reaching it. This avoids the brittle "max=10"
 * heuristic that would make a 10-finding hypothesis score
 * identically to a 100-finding one.
 *
 * `Findings` are session-scoped (no per-hypothesis link in v0.1),
 * so we treat every finding as evidence for every active
 * hypothesis. The dashboard surfaces this caveat in the gravity
 * card; the constraint engine refines it post-append.
 */
const evidenceStrengthFor = (state: SessionState, h: HypothesisState): number => {
  const findings = state.findings.length;
  let supportingConclusions = 0;
  for (const c of state.conclusions.values()) {
    if (c.state !== "verified") continue;
    if (c.supporting_evidence_ids.includes(h.id)) supportingConclusions += 1;
  }
  const total = findings + supportingConclusions;
  if (total <= 0) return 0;
  return total / (total + 3);
};

/**
 * Reproducibility — fraction of this hypothesis's verifications
 * that passed, weighted by recency (more recent verifications
 * count more). Implementation: pass_count / total_count over the
 * verifications whose `linked_hypothesis_id === h.id`. Recency is
 * a simple linear weight (most-recent run weighted 1.0, earliest
 * 0.5) so a single passing run after several failing ones still
 * pulls the score up.
 *
 * Returns 0 when no verifications target this hypothesis (the
 * scorer treats "no data" as "no evidence", consistent with
 * `evidence_strength`).
 */
const reproducibilityFor = (state: SessionState, h: HypothesisState): number => {
  const verifs: VerificationState[] = [];
  for (const v of state.verifications.values()) {
    if (v.linked_hypothesis_id === h.id) verifs.push(v);
  }
  if (verifs.length === 0) return 0;
  // Sort by started_at ascending (oldest first) so the recency
  // weight runs from 0.5 → 1.0.
  verifs.sort((a, b) => a.started_at.localeCompare(b.started_at));
  let weighted = 0;
  let weightSum = 0;
  for (let i = 0; i < verifs.length; i++) {
    const recencyWeight =
      verifs.length === 1
        ? 1
        : 0.5 + (0.5 * i) / (verifs.length - 1);
    const v = verifs[i]!;
    const passed = v.state === "passed" ? 1 : 0;
    weighted += passed * recencyWeight;
    weightSum += recencyWeight;
  }
  if (weightSum <= 0) return 0;
  const r = weighted / weightSum;
  return r < 0 ? 0 : r > 1 ? 1 : r;
};

/**
 * Verification confidence — uses the hypothesis's
 * `current_confidence` when present (0..100 → 0..1) and falls back
 * to the latest verification outcome:
 *
 *   passed     → 1.0
 *   failed     → 0.0
 *   errored    → 0.2  (signal degraded by tooling)
 *   cancelled  → 0.4  (no signal but not negative)
 *   started    → 0.5  (in-flight; neutral)
 *
 * Returns 0 when there is no signal at all (neither confidence
 * nor any verification touching this hypothesis).
 */
const verificationConfidenceFor = (
  state: SessionState,
  h: HypothesisState,
): number => {
  if (h.current_confidence !== null) {
    const c = h.current_confidence;
    const scaled = c > 1 ? c / 100 : c;
    return scaled < 0 ? 0 : scaled > 1 ? 1 : scaled;
  }
  let latest: VerificationState | null = null;
  for (const v of state.verifications.values()) {
    if (v.linked_hypothesis_id !== h.id) continue;
    if (latest === null || v.started_at > latest.started_at) latest = v;
  }
  if (latest === null) return 0;
  switch (latest.state) {
    case "passed":
      return 1;
    case "failed":
      return 0;
    case "errored":
      return 0.2;
    case "cancelled":
      return 0.4;
    default:
      return 0.5;
  }
};

/**
 * Rank active hypotheses with state-level evidence / reproducibility /
 * confidence filled in. Same return shape as
 * `@cognit/gravity.rankHypotheses` so callers can use either
 * function interchangeably.
 *
 * Stable sort: score DESC, id ASC (matches the gravity package).
 *
 * v1.2.0 AI-rank override mirrors the gravity package: if the
 * hypothesis has an `ai_rank_score`, that score replaces the
 * 5-axis formula result for this ranking (source `"ai"`); the
 * formula is the fallback for hypotheses the AI has not scored
 * (source `"rule"`).
 */
export const rankActiveHypothesesFromState = (
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
    // AI-rank override — see packages/gravity/src/scoring.ts.
    const aiRank = h.ai_rank_score;
    if (aiRank !== null && Number.isFinite(aiRank)) {
      const clamped = aiRank < 0 ? 0 : aiRank > 1 ? 1 : aiRank;
      entries.push({ h, score: clamped, source: "ai" });
      continue;
    }
    const actors = contributingActorsByHypothesis.get(h.id) ?? [];
    const firedAt = firedAtByHypothesis.get(h.id) ?? 0;
    const score = scoreHypothesis(
      {
        evidence_strength: evidenceStrengthFor(state, h),
        reproducibility: reproducibilityFor(state, h),
        verification_confidence: verificationConfidenceFor(state, h),
        actor_trust: meanActorTrust(actors),
        freshness_decay: freshnessForHypothesis(firedAt, nowSec, halfLife),
      },
      cfg,
    );
    entries.push({ h, score, source: "rule" });
  }
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
