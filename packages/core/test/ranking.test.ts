/**
 * packages/core/test/ranking.test.ts — M2.1 deterministic scorer tests.
 *
 * Pure unit tests over the ranker in `@cognit/core/ranking`. Every
 * fixture is a hand-constructed SessionState — no IO, no DB, no AI.
 *
 * Coverage:
 *   - recency wins ties
 *   - verification state dominates (verified > accepted > pending > open)
 *   - rejected loses (negative base + filtered from dedup)
 *   - duplicate collapse (verified wins over newer/accepted twins)
 *   - same-project bonus (memory of the same project outranks cross-project)
 *   - branch hint preference (linked_hypothesis_id match boosts)
 *   - topNByKind caps per kind (continue caps, search caps)
 *   - dedup pass-through kinds (hypothesis, verification, observation)
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTINUE_CAPS,
  DEFAULT_SEARCH_CAPS,
  deduplicateMemories,
  normalizeForDedup,
  rankSessionMemories,
  topNByKind,
  type RankedMemory,
} from "@cognit/core/ranking";
import type {
  ConclusionState,
  DecisionState,
  HypothesisState,
  ObservationState,
  SessionState,
  VerificationState,
} from "@cognit/core/state";

const NOW = Date.parse("2026-06-29T12:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const conclusion = (
  id: string,
  state: ConclusionState["state"],
  text: string,
  createdAtMs: number,
): ConclusionState => ({
  id,
  text,
  state,
  verification_id: null,
  supporting_evidence_ids: [],
  reason: null,
  created_at: iso(createdAtMs),
  last_event_id: id,
  last_event_at: iso(createdAtMs),
});

const decision = (
  id: string,
  state: DecisionState["state"],
  text: string,
  createdAtMs: number,
  basedOnIds: ReadonlyArray<string> = [],
): DecisionState => ({
  id,
  text,
  state,
  based_on_conclusion_ids: basedOnIds,
  reason: null,
  superseded_by_decision_id: null,
  created_at: iso(createdAtMs),
  last_event_id: id,
  last_event_at: iso(createdAtMs),
});

const hypothesis = (
  id: string,
  state: HypothesisState["current_state"],
  title: string,
  createdAtMs: number,
): HypothesisState => ({
  id,
  title,
  text: title,
  current_state: state,
  current_confidence: null,
  current_reason: null,
  reason_type: null,
  superseded_by_id: null,
  promoted_to_theory_id: null,
  belongs_to_theory_id: null,
  created_at: iso(createdAtMs),
  last_event_id: id,
  last_event_at: iso(createdAtMs),
  gravity_fired_at: Math.floor(createdAtMs / 1000),
  ai_rank_score: null,
  ai_rank_reasoning: null,
  ai_rank_evaluator: null,
  ai_rank_at: null,
  ai_rank_event_id: null,
});

const verification = (
  id: string,
  state: VerificationState["state"],
  command: string,
  startedMs: number,
  linkedHypothesisId: string | null = null,
): VerificationState => ({
  id,
  command,
  type: "test",
  linked_hypothesis_id: linkedHypothesisId,
  state,
  stderr_excerpt: null,
  error: null,
  parent_verification_id: null,
  started_at: iso(startedMs),
  ended_at: null,
  expected_duration_ms: null,
  duration_ms: null,
  exit_code: null,
  stdout_excerpt: null,
  created_artifact_id: null,
  last_event_id: id,
});

const observation = (
  id: string,
  text: string,
  ms: number,
): ObservationState => ({
  id,
  text,
  created_at: iso(ms),
  last_event_id: id,
});

const buildState = (
  projectId: string,
  extra: {
    readonly conclusions?: ReadonlyArray<ConclusionState>;
    readonly decisions?: ReadonlyArray<DecisionState>;
    readonly hypotheses?: ReadonlyArray<HypothesisState>;
    readonly verifications?: ReadonlyArray<VerificationState>;
    readonly observations?: ReadonlyArray<ObservationState>;
    readonly currentHypothesisId?: string | null;
  } = {},
): SessionState => {
  const conclusions = new Map((extra.conclusions ?? []).map((c) => [c.id, c]));
  const decisions = new Map((extra.decisions ?? []).map((d) => [d.id, d]));
  const hypotheses = new Map((extra.hypotheses ?? []).map((h) => [h.id, h]));
  const verifications = new Map((extra.verifications ?? []).map((v) => [v.id, v]));
  return {
    session_id: "sess-1",
    project_id: projectId,
    goal: "test",
    parent_session_id: null,
    status: "active",
    current_hypothesis_id: extra.currentHypothesisId ?? null,
    current_theory_id: null,
    current_decision_id: null,
    current_conclusion_id: null,
    current_verification_id: null,
    observations: extra.observations ?? [],
    actions: [],
    findings: [],
    hypotheses,
    theories: new Map(),
    experiments: new Map(),
    decisions,
    conclusions,
    verifications,
    artifacts: new Map(),
    edges: [],
    timeline: [],
    snapshot_event_id: null,
    last_event_id: "evt-last",
    last_event_at: iso(NOW),
  };
};

describe("rankSessionMemories — verification dominates", () => {
  it("verified conclusion beats accepted decision of the same recency", () => {
    const c = conclusion("c-1", "verified", "auth uses JWT", NOW - 60_000);
    const d = decision("d-1", "accepted", "use JWT", NOW - 60_000);
    const state = buildState("p1", { conclusions: [c], decisions: [d] });
    const ranked = rankSessionMemories(state, { nowMs: NOW, projectId: "p1" });
    expect(ranked[0]!.id).toBe("c-1");
    expect(ranked[0]!.trust).toBe("verified");
  });
});

describe("rankSessionMemories — recency wins ties", () => {
  it("newer conclusion beats older verified twin when recency bonus flips the tie", () => {
    // Both verified (base 10). Older conclusion is 14 days stale
    // → recency = -3. Newer conclusion is 6 hours old → recency ≈ +3.
    const old = conclusion("c-old", "verified", "auth is stable", NOW - 14 * 86_400_000);
    const fresh = conclusion("c-new", "verified", "auth is stable", NOW - 6 * 3_600_000);
    const state = buildState("p1", { conclusions: [old, fresh] });
    const ranked = rankSessionMemories(state, { nowMs: NOW, projectId: "p1" });
    expect(ranked[0]!.id).toBe("c-new");
    expect(ranked[1]!.id).toBe("c-old");
  });
});

describe("rankSessionMemories — rejected loses", () => {
  it("rejected decision sorts behind every verified/accepted/pending/open", () => {
    const rej = decision("d-rej", "rejected", "drop the cache", NOW - 60_000);
    const acc = decision("d-acc", "accepted", "keep the cache", NOW - 60_000);
    const state = buildState("p1", { decisions: [rej, acc] });
    const ranked = rankSessionMemories(state, { nowMs: NOW, projectId: "p1" });
    expect(ranked[0]!.id).toBe("d-acc");
    expect(ranked[0]!.trust).toBe("accepted");
    // Rejected must be last.
    expect(ranked[ranked.length - 1]!.id).toBe("d-rej");
    expect(ranked[ranked.length - 1]!.trust).toBe("rejected");
  });
});

describe("rankSessionMemories — same-project bonus", () => {
  it("same-project memory beats cross-project twin", () => {
    // Build two states (simulate two projects). Score each.
    const c1 = conclusion("c1", "verified", "use refresh tokens", NOW - 60_000);
    const c2 = conclusion("c2", "verified", "use refresh tokens", NOW - 60_000);
    const state1 = buildState("p1", { conclusions: [c1] });
    const state2 = buildState("p2", { conclusions: [c2] });

    // Ask the ranker from project p1's perspective. p1's memory should
    // get a full bonus; p2's memory should be penalised.
    const r1 = rankSessionMemories(state1, { nowMs: NOW, projectId: "p1" });
    const r2 = rankSessionMemories(state2, { nowMs: NOW, projectId: "p1" });
    expect(r1[0]!.score).toBeGreaterThan(r2[0]!.score);
    // And the cross-project memory must carry the explicit reason.
    expect(r2[0]!.reasons.some((x) => x.startsWith("cross-project"))).toBe(true);
  });
});

describe("rankSessionMemories — branch hint preference", () => {
  it("memory on the active branch outranks an off-branch twin", () => {
    const on = hypothesis("hyp-on", "active", "test caching", NOW - 60_000);
    const off = hypothesis("hyp-off", "active", "test caching", NOW - 60_000);
    const state = buildState("p1", {
      hypotheses: [on, off],
      currentHypothesisId: "hyp-on",
    });
    const ranked = rankSessionMemories(state, {
      nowMs: NOW,
      projectId: "p1",
      branchHint: "hyp-on",
    });
    expect(ranked[0]!.id).toBe("hyp-on");
    expect(ranked[0]!.reasons).toContain("active branch");
  });
});

describe("rankSessionMemories — query match bonus", () => {
  it("matching token adds a reason and a score bonus", () => {
    const c = conclusion("c-auth", "verified", "auth uses refresh tokens", NOW - 60_000);
    const d = decision("d-cache", "accepted", "drop the optimistic cache", NOW - 60_000);
    const state = buildState("p1", { conclusions: [c], decisions: [d] });
    const ranked = rankSessionMemories(state, {
      nowMs: NOW,
      projectId: "p1",
      query: "auth refresh",
    });
    const auth = ranked.find((m) => m.id === "c-auth")!;
    const cache = ranked.find((m) => m.id === "d-cache")!;
    expect(auth.score).toBeGreaterThan(cache.score);
    expect(auth.reasons.some((x) => x.startsWith("matches"))).toBe(true);
  });
});

describe("topNByKind — caps per kind", () => {
  it("respects DEFAULT_CONTINUE_CAPS", () => {
    // Build 5 verified conclusions + 5 verified decisions.
    const conclusions = Array.from({ length: 5 }, (_, i) =>
      conclusion(`c-${i}`, "verified", `conclusion ${i}`, NOW - i * 60_000),
    );
    const decisions = Array.from({ length: 5 }, (_, i) =>
      decision(`d-${i}`, "accepted", `decision ${i}`, NOW - i * 60_000),
    );
    const state = buildState("p1", { conclusions, decisions });
    const ranked = rankSessionMemories(state, { nowMs: NOW, projectId: "p1" });
    const capped = topNByKind(ranked, DEFAULT_CONTINUE_CAPS);
    expect(capped.filter((m) => m.kind === "conclusion")).toHaveLength(3);
    expect(capped.filter((m) => m.kind === "decision")).toHaveLength(3);
  });

  it("respects DEFAULT_SEARCH_CAPS", () => {
    const conclusions = Array.from({ length: 4 }, (_, i) =>
      conclusion(`c-${i}`, "verified", `auth conclusion ${i}`, NOW - i * 60_000),
    );
    const state = buildState("p1", { conclusions });
    const ranked = rankSessionMemories(state, {
      nowMs: NOW,
      projectId: "p1",
      query: "auth",
    });
    const capped = topNByKind(ranked, DEFAULT_SEARCH_CAPS);
    expect(capped.filter((m) => m.kind === "conclusion")).toHaveLength(2);
  });
});

describe("deduplicateMemories — collapse duplicates", () => {
  it("verified wins over newer/accepted twin", () => {
    // Conclusions and decisions share dedup space by default, so all
    // three text-equivalent memories collapse into the verified
    // conclusion (highest trust, freshest).
    const olderUnverified = conclusion("c-1", "unverified", "auth uses refresh tokens", NOW - 86_400_000);
    const newerAccepted = decision("d-1", "accepted", "Auth uses  refresh tokens", NOW - 60_000);
    const freshVerified = conclusion("c-2", "verified", "auth uses refresh tokens", NOW - 3_600_000);
    const state = buildState("p1", {
      conclusions: [olderUnverified, freshVerified],
      decisions: [newerAccepted],
    });
    const ranked = rankSessionMemories(state, { nowMs: NOW, projectId: "p1" });
    const survivors = deduplicateMemories(ranked);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.trust).toBe("verified");
    expect(survivors[0]!.id).toBe("c-2");
  });

  it("rejected entries never beat a non-rejected twin", () => {
    // Same text. Accepted twin must win. Rejected is dropped from the
    // bucket because the accepted twin dominates it.
    const accepted = decision("d-1", "accepted", "use refresh tokens", NOW - 60_000);
    const rejected = decision("d-2", "rejected", "use refresh tokens", NOW - 60_000);
    const state = buildState("p1", { decisions: [accepted, rejected] });
    const ranked = rankSessionMemories(state, { nowMs: NOW, projectId: "p1" });
    const survivors = deduplicateMemories(ranked);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.id).toBe("d-1");
  });

  it("lonely rejected entries survive on their own (no silent drop)", () => {
    // Only one entry, and it's rejected — it must still surface so
    // the agent knows the rejection context.
    const rejected = decision("d-1", "rejected", "drop the queue", NOW - 60_000);
    const state = buildState("p1", { decisions: [rejected] });
    const ranked = rankSessionMemories(state, { nowMs: NOW, projectId: "p1" });
    const survivors = deduplicateMemories(ranked);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.trust).toBe("rejected");
  });

  it("newer accepted wins when neither twin is verified", () => {
    const old = decision("d-old", "proposed", "drop the optimistic cache", NOW - 7 * 86_400_000);
    const fresh = decision("d-new", "accepted", "drop the optimistic cache", NOW - 60_000);
    const state = buildState("p1", { decisions: [old, fresh] });
    const ranked = rankSessionMemories(state, { nowMs: NOW, projectId: "p1" });
    const survivors = deduplicateMemories(ranked);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.trust).toBe("accepted");
    expect(survivors[0]!.id).toBe("d-new");
  });

  it("passes through non-dedup kinds (hypothesis/verification/observation)", () => {
    const h = hypothesis("h-1", "active", "investigate caching", NOW - 60_000);
    const v = verification("v-1", "started", "pnpm test", NOW - 60_000);
    const o = observation("o-1", "first observation", NOW - 60_000);
    const state = buildState("p1", {
      hypotheses: [h],
      verifications: [v],
      observations: [o],
    });
    const ranked = rankSessionMemories(state, {
      nowMs: NOW,
      projectId: "p1",
    }, {
      includeObservations: true,
    });
    // sanity: ranker yields all three before dedup
    expect(ranked.map((m) => m.kind).sort()).toEqual([
      "hypothesis",
      "observation",
      "verification",
    ]);
    const survivors = deduplicateMemories(ranked);
    expect(survivors).toHaveLength(3);
    expect(survivors.map((s) => s.kind).sort()).toEqual([
      "hypothesis",
      "observation",
      "verification",
    ]);
  });
});

describe("normalizeForDedup — punctuation/whitespace insensitive", () => {
  it("collapses equivalent text into one bucket", () => {
    expect(normalizeForDedup("Auth uses refresh tokens.")).toBe(
      normalizeForDedup("auth uses refresh tokens"),
    );
    expect(normalizeForDedup("Drop the optimistic cache")).toBe(
      normalizeForDedup("drop the optimistic cache"),
    );
  });

  it("drops short tokens (<=2 chars) so 'I', 'a' noise doesn't split buckets", () => {
    // Both produce the same key — short words stripped.
    expect(normalizeForDedup("a b c auth uses refresh")).toBe(
      normalizeForDedup("auth uses refresh"),
    );
  });
});

describe("explanations — every ranked memory carries stable ✓-bullets", () => {
  it("verified conclusion emits 'verified' bullet", () => {
    const c = conclusion("c-1", "verified", "auth uses refresh tokens", NOW - 60_000);
    const state = buildState("p1", { conclusions: [c] });
    const ranked = rankSessionMemories(state, {
      nowMs: NOW,
      projectId: "p1",
      query: "auth",
    });
    expect(ranked[0]!.reasons).toContain("verified");
    expect(ranked[0]!.reasons).toContain("current project");
  });

  it("non-empty reasons list on every ranked memory", () => {
    const c = conclusion("c-1", "verified", "x", NOW);
    const d = decision("d-1", "accepted", "y", NOW);
    const h = hypothesis("h-1", "active", "z", NOW);
    const v = verification("v-1", "passed", "w", NOW);
    const state = buildState("p1", {
      conclusions: [c],
      decisions: [d],
      hypotheses: [h],
      verifications: [v],
    });
    const ranked = rankSessionMemories(state, { nowMs: NOW, projectId: "p1" });
    for (const m of ranked) {
      expect(m.reasons.length).toBeGreaterThan(0);
      // Always ends with the kind label so callers can use it as a
      // stable trailing tag.
      expect(m.reasons[m.reasons.length - 1]).toBe(m.kind);
    }
  });

  it("reference count surfaces as 'referenced by N later references'", () => {
    const target = conclusion("c-target", "verified", "auth uses refresh tokens", NOW - 3_600_000);
    const consumer = decision(
      "d-consumer",
      "accepted",
      "follow-up action",
      NOW - 1_000,
      ["c-target"],
    );
    const state = buildState("p1", {
      conclusions: [target],
      decisions: [consumer],
    });
    const ranked = rankSessionMemories(state, {
      nowMs: NOW,
      projectId: "p1",
      query: "auth",
    });
    const r = ranked.find((m) => m.id === "c-target")!;
    expect(r.reasons).toContain("referenced by 1 later reference");
  });
});

describe("integration — rank → dedup → cap is deterministic", () => {
  it("same inputs produce identical output every call", () => {
    const cs = Array.from({ length: 6 }, (_, i) =>
      conclusion(`c-${i}`, i === 0 ? "verified" : i === 1 ? "rejected" : "unverified", `conclusion ${i}`, NOW - i * 3_600_000),
    );
    const ds = Array.from({ length: 4 }, (_, i) =>
      decision(`d-${i}`, i === 0 ? "accepted" : "proposed", `decision ${i}`, NOW - i * 60_000),
    );
    const state = buildState("p1", { conclusions: cs, decisions: ds });

    const run = (): ReadonlyArray<RankedMemory> =>
      topNByKind(deduplicateMemories(rankSessionMemories(state, { nowMs: NOW, projectId: "p1" })), DEFAULT_CONTINUE_CAPS);

    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
