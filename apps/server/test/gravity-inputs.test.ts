/**
 * apps/server/test/gravity-inputs.test.ts — unit tests for
 * `rankActiveHypothesesFromState`, the server-side AI-rank override
 * mirror of `packages/gravity/src/scoring.ts:rankHypotheses`.
 *
 * Why a unit test instead of an HTTP-level test: the only way to push
 * an `ai_rank_score` of `±Infinity` into state via HTTP is for the
 * reducer to fold it from an event payload — but the payload Schema
 * enforces score in [0, 1], so a malformed value cannot reach state.
 * The race-condition window (malformed value in state via a direct
 * caller / future schema drift) is narrow but real, so this test pins
 * the guard behaviour at the function boundary, mirroring the
 * equivalent test in `packages/gravity/test/scoring.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig } from "@cognit/core/config";
import {
  emptySessionState,
  type HypothesisState,
  type SessionState,
} from "@cognit/core/state";
import { rankActiveHypothesesFromState } from "../src/gravity-inputs.js";

const baseCfg = () => defaultConfig("test-server-gravity");

const baseActive = (
  id: string,
  overrides: Partial<HypothesisState> = {},
): HypothesisState => ({
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

const buildState = (
  hypotheses: ReadonlyArray<HypothesisState>,
): SessionState => {
  const s = emptySessionState({ session_id: "S", project_id: "P", goal: "g" });
  const m = new Map<string, HypothesisState>();
  for (const h of hypotheses) m.set(h.id, h);
  return { ...s, hypotheses: m };
};

describe("rankActiveHypothesesFromState — ±Infinity mirror fix", () => {
  it("+Infinity ai_rank_score falls back to rule-based, not pinned to 1", () => {
    // Without the fix, the inline `aiRank < 0 ? 0 : aiRank > 1 ? 1 : aiRank`
    // clamp maps +Infinity → 1 and pins the row at the top of the rank.
    const state = buildState([
      baseActive("H-1"),
      baseActive("H-2", {
        ai_rank_score: Number.POSITIVE_INFINITY,
        ai_rank_reasoning: "x",
        ai_rank_evaluator: "ai-supervisor",
        ai_rank_at: "2026-06-19T00:00:00.000Z",
        ai_rank_event_id: "ev2",
      }),
    ]);
    const out = rankActiveHypothesesFromState(
      state,
      baseCfg(),
      new Map(),
      new Map([
        ["H-1", 1_700_000_000],
        ["H-2", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    // H-2 must be rule-scored; without the fix it would be source "ai"
    // pinned to score 1.
    const h2 = out.find((r) => r.id === "H-2");
    expect(h2?.source).toBe("rule");
  });

  it("-Infinity ai_rank_score falls back to rule-based, not clamped to 0", () => {
    // Without the fix, -Infinity clamps to 0 and the row looks like a
    // legitimate "AI rank = lowest" entry, hiding the malformed data.
    const state = buildState([
      baseActive("H-1"),
      baseActive("H-2", {
        ai_rank_score: Number.NEGATIVE_INFINITY,
        ai_rank_reasoning: "x",
        ai_rank_evaluator: "ai-supervisor",
        ai_rank_at: "2026-06-19T00:00:00.000Z",
        ai_rank_event_id: "ev2",
      }),
    ]);
    const out = rankActiveHypothesesFromState(
      state,
      baseCfg(),
      new Map(),
      new Map([
        ["H-1", 1_700_000_000],
        ["H-2", 1_700_000_000],
      ]),
      1_700_000_000,
    );
    const h2 = out.find((r) => r.id === "H-2");
    expect(h2?.source).toBe("rule");
  });
});