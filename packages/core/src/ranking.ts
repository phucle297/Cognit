/**
 * packages/core/src/ranking.ts — M2.1 memory ranking engine.
 *
 * Pure deterministic scorer. Zero deps on AI, embeddings, vectors.
 * Every score is a sum of explicit signal weights — every selected
 * memory carries the reason tags that explain the score.
 *
 * Signals:
 *   - trust state (verified > accepted > pending > open) with rejected
 *     demoted to a negative base so it sorts last but is still
 *     available for an explicit "why rejected" view when callers ask.
 *   - recency (epoch-ms decay: fresher events win at +1, two-week
 *     stale capped at -2, never below -3).
 *   - references — decisions/conclusions that quote this memory bump
 *     it by 0.5 each.
 *   - query match (search only): substring overlap bonus proportional
 *     to token coverage.
 *   - branch + project preference: full bonus only when the memory
 *     belongs to the active branch (linked hypothesis match) or the
 *     current project. Cross-project memories stay available but get
 *     a small negative nudge so same-project memories win ties.
 *
 * The scorer is a pure function over the SessionState. No IO. No
 * Effect. No time source other than the caller-supplied `nowMs`.
 * That keeps it cheap to test and trivial to reason about.
 */
import type {
  ConclusionState,
  DecisionState,
  HypothesisState,
  SessionState,
  VerificationState,
} from "./state";

/** Kind of memory item being ranked. */
export type MemoryKind =
  | "conclusion"
  | "decision"
  | "hypothesis"
  | "verification"
  | "observation";

/**
 * A single ranked memory item. `reasons` is a non-empty list of
 * short, pre-translated strings ready to render — "verified",
 * "referenced by 3 later decisions", etc. Callers MUST treat
 * `reasons` as the explanation surface; never show `score` raw.
 */
export interface RankedMemory {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly text: string;
  /** Numeric score. For tie-breaking / debugging only. */
  readonly score: number;
  /** Trust vocabulary: "verified" | "accepted" | "pending" | "open" | "rejected". */
  readonly trust: MemoryTrust;
  /** Sortable timestamp (epoch ms). */
  readonly createdAtMs: number;
  /**
   * Pre-rendered explanations. Each entry is a complete ✓-bullet.
   * Stable order (deterministic). Empty when the caller asked to
   * hide explanations.
   */
  readonly reasons: ReadonlyArray<string>;
}

export type MemoryTrust = "verified" | "accepted" | "pending" | "open" | "rejected";

/** Optional context that boosts same-branch/same-project memories. */
export interface RankingContext {
  /** Wall-clock epoch ms for recency decay. Caller-supplied. */
  readonly nowMs: number;
  /** Free-text query (search only). Empty string = no query bonus. */
  readonly query?: string;
  /** Current project id — full bonus on exact match. */
  readonly projectId?: string;
  /** Branch hint — usually the linked_hypothesis_id from the active session. */
  readonly branchHint?: string | null;
}

/** Trust base scores. Rejected gets a negative base so it sorts last. */
const TRUST_BASE: Record<MemoryTrust, number> = {
  verified: 10,
  accepted: 8,
  pending: 5,
  open: 4,
  rejected: -2,
};

/** Cap for the recency modifier. */
const RECENCY_CAP = 3;

/** Half-life window in ms for the recency decay. */
const RECENCY_HALFLIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-reference weight — every decision that quotes this memory adds this much. */
const REFERENCE_WEIGHT = 0.5;

/** Max total reference bonus. */
const REFERENCE_CAP = 2;

/** Cross-project penalty when memory project differs from caller project. */
const CROSS_PROJECT_PENALTY = 2;

/** Branch match bonus when memory belongs to the branch hint. */
const BRANCH_BONUS = 4;

/** Query match bonus per matched token (capped). */
const QUERY_TOKEN_CAP = 2;
const QUERY_TOKEN_WEIGHT = 1.0;

/** Stable string used to render a reason. Always a complete sentence fragment. */
const r = (s: string): string => s;

const trustFromConclusion = (state: ConclusionState["state"]): MemoryTrust =>
  state === "verified" ? "verified" : state === "rejected" ? "rejected" : "open";

const trustFromDecision = (state: DecisionState["state"]): MemoryTrust => {
  if (state === "accepted") return "accepted";
  if (state === "rejected") return "rejected";
  if (state === "superseded") return "rejected";
  return "pending";
};

const trustFromHypothesis = (state: HypothesisState["current_state"]): MemoryTrust => {
  if (state === "promoted") return "accepted";
  if (state === "rejected") return "rejected";
  return "open";
};

const trustFromVerification = (
  state: VerificationState["state"],
): MemoryTrust => {
  if (state === "passed") return "verified";
  if (state === "failed" || state === "errored" || state === "cancelled") {
    return "rejected";
  }
  return "open";
};

/** Parse ISO-8601 timestamp into epoch ms. NaN becomes 0 (oldest). */
const isoMs = (s: string): number => {
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : 0;
};

/** Recent-event recency weight: linear decay, clamped. */
const recencyBoost = (createdAtMs: number, nowMs: number): number => {
  const ageMs = Math.max(0, nowMs - createdAtMs);
  const halflives = ageMs / RECENCY_HALFLIFE_MS;
  // +RECENCY_CAP at instant, 0 at one half-life, -RECENCY_CAP at two half-lives.
  const raw = RECENCY_CAP - halflives * RECENCY_CAP;
  const clamped = Math.max(-RECENCY_CAP, Math.min(RECENCY_CAP, raw));
  // Round to one decimal for stable tests.
  return Math.round(clamped * 10) / 10;
};

/** Tokenize for query overlap. Lowercase, alnum, drop empties. */
const tokenize = (s: string): ReadonlyArray<string> =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

/** Query bonus: how many unique query tokens appear in `text`. */
const queryBoost = (
  query: string,
  text: string,
): { readonly score: number; readonly matched: ReadonlyArray<string> } => {
  const qt = tokenize(query);
  if (qt.length === 0) return { score: 0, matched: [] };
  const tt = new Set(tokenize(text));
  const matched: string[] = [];
  for (const t of qt) if (tt.has(t)) matched.push(t);
  const unique = new Set(matched).size;
  return {
    score: Math.min(QUERY_TOKEN_CAP, unique * QUERY_TOKEN_WEIGHT),
    matched,
  };
};

/** Count how many other entities reference a given id within `state`. */
const referenceCount = (
  id: string,
  state: SessionState,
): { readonly decisions: number; readonly conclusions: number; readonly total: number } => {
  let decisions = 0;
  for (const d of state.decisions.values()) {
    for (const c of d.based_on_conclusion_ids) if (c === id) decisions += 1;
  }
  let conclusions = 0;
  for (const c of state.conclusions.values()) {
    for (const s of c.supporting_evidence_ids) if (s === id) conclusions += 1;
  }
  return { decisions, conclusions, total: decisions + conclusions };
};

/** Build reason tags for a memory. Stable order, no duplicates. */
const buildReasons = (input: {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly trust: MemoryTrust;
  readonly recencyBoost: number;
  readonly referenceTotal: number;
  readonly queryMatched: ReadonlyArray<string>;
  readonly branchHint: string | null;
  readonly memoryHypothesisId: string | null;
  readonly memoryProjectId: string;
  readonly currentProjectId: string | undefined;
  readonly sessionActive: boolean;
}): ReadonlyArray<string> => {
  const reasons: string[] = [];
  if (input.trust === "verified") reasons.push(r("verified"));
  if (input.trust === "accepted") reasons.push(r("accepted"));
  if (input.trust === "pending") reasons.push(r("proposed — awaiting review"));
  if (input.trust === "open") reasons.push(r("open — still in flight"));
  if (input.trust === "rejected") reasons.push(r("rejected — shown for context only"));

  // Project match. Same-project = "active project"; cross-project = explicit.
  if (input.currentProjectId && input.memoryProjectId === input.currentProjectId) {
    reasons.push(r("current project"));
  } else if (input.currentProjectId && input.memoryProjectId !== input.currentProjectId) {
    reasons.push(r(`cross-project (${shortId(input.memoryProjectId)})`));
  }

  // Branch preference: indicate when the caller is on this memory's branch.
  if (
    input.branchHint &&
    input.memoryHypothesisId &&
    input.branchHint === input.memoryHypothesisId
  ) {
    reasons.push(r("active branch"));
  }

  // References.
  if (input.referenceTotal > 0) {
    const refs = input.referenceTotal === 1 ? "1 later reference" : `${input.referenceTotal} later references`;
    reasons.push(r(`referenced by ${refs}`));
  }

  // Recency — only emit when meaningful (high or low).
  if (input.recencyBoost >= RECENCY_CAP - 0.1) {
    reasons.push(r("just created"));
  } else if (input.recencyBoost <= -RECENCY_CAP + 0.1) {
    reasons.push(r("stale — older than two weeks"));
  }

  // Query match.
  if (input.queryMatched.length > 0) {
    const sample = input.queryMatched.slice(0, 3).map((s) => `"${s}"`).join(", ");
    reasons.push(r(`matches ${sample}`));
  }

  // Session activity hint.
  if (input.sessionActive) {
    reasons.push(r("active session"));
  }

  // Kind fingerprint so callers can dedupe render with one label per kind.
  reasons.push(r(kindLabel(input.kind)));
  return reasons;
};

const kindLabel = (k: MemoryKind): string => {
  switch (k) {
    case "conclusion":
      return "conclusion";
    case "decision":
      return "decision";
    case "hypothesis":
      return "hypothesis";
    case "verification":
      return "verification";
    case "observation":
      return "observation";
  }
};

const shortId = (s: string): string => (s.length <= 8 ? s : s.slice(0, 8));

/** Score one memory candidate. Pure. */
const scoreOne = (
  base: { readonly trust: MemoryTrust; readonly createdAtMs: number; readonly text: string },
  ctx: RankingContext,
  extras: {
    readonly memoryHypothesisId: string | null;
    readonly memoryProjectId: string;
    readonly sessionActive: boolean;
    readonly referenceTotal: number;
    readonly queryMatched: ReadonlyArray<string>;
  },
): { readonly score: number; readonly recencyBoost: number } => {
  const rec = recencyBoost(base.createdAtMs, ctx.nowMs);
  const ref = Math.min(REFERENCE_CAP, extras.referenceTotal * REFERENCE_WEIGHT);
  const q = Math.min(QUERY_TOKEN_CAP, extras.queryMatched.length * QUERY_TOKEN_WEIGHT);
  const proj =
    ctx.projectId && extras.memoryProjectId !== ctx.projectId
      ? -CROSS_PROJECT_PENALTY
      : 0;
  const branch =
    ctx.branchHint &&
    extras.memoryHypothesisId &&
    ctx.branchHint === extras.memoryHypothesisId
      ? BRANCH_BONUS
      : 0;
  const total =
    TRUST_BASE[base.trust] + rec + ref + q + proj + branch;
  return {
    score: Math.round(total * 10) / 10,
    recencyBoost: rec,
  };
};

const rankObservations = (
  state: SessionState,
  ctx: RankingContext,
): ReadonlyArray<RankedMemory> => {
  return state.observations.map((o) => {
    const q = queryBoost(ctx.query ?? "", o.text);
    const { score } = scoreOne(
      { trust: "open", createdAtMs: isoMs(o.created_at), text: o.text },
      ctx,
      {
        memoryHypothesisId: null,
        memoryProjectId: state.project_id,
        sessionActive: state.status === "active",
        referenceTotal: 0,
        queryMatched: q.matched,
      },
    );
    return {
      id: o.id,
      kind: "observation" as const,
      text: o.text,
      score,
      trust: "open" as const,
      createdAtMs: isoMs(o.created_at),
      reasons: buildReasons({
        kind: "observation",
        text: o.text,
        trust: "open",
        recencyBoost: recencyBoost(isoMs(o.created_at), ctx.nowMs),
        referenceTotal: 0,
        queryMatched: q.matched,
        branchHint: ctx.branchHint ?? null,
        memoryHypothesisId: null,
        memoryProjectId: state.project_id,
        currentProjectId: ctx.projectId,
        sessionActive: state.status === "active",
      }),
    };
  });
};

const rankConclusions = (
  state: SessionState,
  ctx: RankingContext,
): ReadonlyArray<RankedMemory> => {
  return Array.from(state.conclusions.values()).map((c) => {
    const trust = trustFromConclusion(c.state);
    const refs = referenceCount(c.id, state);
    const q = queryBoost(ctx.query ?? "", c.text);
    const { score, recencyBoost: rec } = scoreOne(
      { trust, createdAtMs: isoMs(c.created_at), text: c.text },
      ctx,
      {
        memoryHypothesisId: null,
        memoryProjectId: state.project_id,
        sessionActive: state.status === "active",
        referenceTotal: refs.total,
        queryMatched: q.matched,
      },
    );
    return {
      id: c.id,
      kind: "conclusion" as const,
      text: c.text,
      score,
      trust,
      createdAtMs: isoMs(c.created_at),
      reasons: buildReasons({
        kind: "conclusion",
        text: c.text,
        trust,
        recencyBoost: rec,
        referenceTotal: refs.total,
        queryMatched: q.matched,
        branchHint: ctx.branchHint ?? null,
        memoryHypothesisId: null,
        memoryProjectId: state.project_id,
        currentProjectId: ctx.projectId,
        sessionActive: state.status === "active",
      }),
    };
  });
};

const rankDecisions = (
  state: SessionState,
  ctx: RankingContext,
): ReadonlyArray<RankedMemory> => {
  return Array.from(state.decisions.values()).map((d) => {
    const trust = trustFromDecision(d.state);
    const refs = referenceCount(d.id, state);
    const q = queryBoost(ctx.query ?? "", d.text);
    const { score, recencyBoost: rec } = scoreOne(
      { trust, createdAtMs: isoMs(d.created_at), text: d.text },
      ctx,
      {
        memoryHypothesisId: null,
        memoryProjectId: state.project_id,
        sessionActive: state.status === "active",
        referenceTotal: refs.total,
        queryMatched: q.matched,
      },
    );
    return {
      id: d.id,
      kind: "decision" as const,
      text: d.text,
      score,
      trust,
      createdAtMs: isoMs(d.created_at),
      reasons: buildReasons({
        kind: "decision",
        text: d.text,
        trust,
        recencyBoost: rec,
        referenceTotal: refs.total,
        queryMatched: q.matched,
        branchHint: ctx.branchHint ?? null,
        memoryHypothesisId: null,
        memoryProjectId: state.project_id,
        currentProjectId: ctx.projectId,
        sessionActive: state.status === "active",
      }),
    };
  });
};

const rankHypotheses = (
  state: SessionState,
  ctx: RankingContext,
): ReadonlyArray<RankedMemory> => {
  return Array.from(state.hypotheses.values()).map((h) => {
    const trust = trustFromHypothesis(h.current_state);
    const refs = referenceCount(h.id, state);
    const q = queryBoost(ctx.query ?? "", h.title + " " + h.text);
    const { score, recencyBoost: rec } = scoreOne(
      { trust, createdAtMs: isoMs(h.created_at), text: h.title },
      ctx,
      {
        memoryHypothesisId: h.id,
        memoryProjectId: state.project_id,
        sessionActive: state.status === "active",
        referenceTotal: refs.total,
        queryMatched: q.matched,
      },
    );
    return {
      id: h.id,
      kind: "hypothesis" as const,
      text: h.title,
      score,
      trust,
      createdAtMs: isoMs(h.created_at),
      reasons: buildReasons({
        kind: "hypothesis",
        text: h.title,
        trust,
        recencyBoost: rec,
        referenceTotal: refs.total,
        queryMatched: q.matched,
        branchHint: ctx.branchHint ?? null,
        memoryHypothesisId: h.id,
        memoryProjectId: state.project_id,
        currentProjectId: ctx.projectId,
        sessionActive: state.status === "active",
      }),
    };
  });
};

const rankVerifications = (
  state: SessionState,
  ctx: RankingContext,
): ReadonlyArray<RankedMemory> => {
  return Array.from(state.verifications.values()).map((v) => {
    const trust = trustFromVerification(v.state);
    const refs = referenceCount(v.id, state);
    const q = queryBoost(ctx.query ?? "", v.command);
    const { score, recencyBoost: rec } = scoreOne(
      { trust, createdAtMs: isoMs(v.started_at), text: v.command },
      ctx,
      {
        memoryHypothesisId: v.linked_hypothesis_id,
        memoryProjectId: state.project_id,
        sessionActive: state.status === "active",
        referenceTotal: refs.total,
        queryMatched: q.matched,
      },
    );
    return {
      id: v.id,
      kind: "verification" as const,
      text: v.command,
      score,
      trust,
      createdAtMs: isoMs(v.started_at),
      reasons: buildReasons({
        kind: "verification",
        text: v.command,
        trust,
        recencyBoost: rec,
        referenceTotal: refs.total,
        queryMatched: q.matched,
        branchHint: ctx.branchHint ?? null,
        memoryHypothesisId: v.linked_hypothesis_id,
        memoryProjectId: state.project_id,
        currentProjectId: ctx.projectId,
        sessionActive: state.status === "active",
      }),
    };
  });
};

/**
 * Rank every memory in a session. Excludes pure observations from the
 * recall surface by default (`includeObservations` defaults to false)
 * — observations are noisy and the recall layer already captures the
 * latest one in the `Doing:` block.
 */
export function rankSessionMemories(
  state: SessionState,
  ctx: RankingContext,
  opts: { readonly includeObservations?: boolean } = {},
): ReadonlyArray<RankedMemory> {
  const includeObs = opts.includeObservations ?? false;
  const out: RankedMemory[] = [];
  out.push(...rankConclusions(state, ctx));
  out.push(...rankDecisions(state, ctx));
  out.push(...rankHypotheses(state, ctx));
  out.push(...rankVerifications(state, ctx));
  if (includeObs) out.push(...rankObservations(state, ctx));
  // Stable sort: score desc, then createdAtMs desc, then id asc (final tie).
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return a.id.localeCompare(b.id);
  });
  return out;
}

/**
 * Top-N caps per kind. Defaults sized for the `continue` surface —
 * small, scannable, deterministic.
 */
export interface TopNCaps {
  readonly conclusions: number;
  readonly decisions: number;
  readonly hypotheses: number;
  readonly verifications: number;
  readonly observations: number;
}

export const DEFAULT_CONTINUE_CAPS: TopNCaps = {
  conclusions: 3,
  decisions: 3,
  hypotheses: 3,
  verifications: 2,
  observations: 1,
};

export const DEFAULT_SEARCH_CAPS: TopNCaps = {
  conclusions: 2,
  decisions: 2,
  hypotheses: 2,
  verifications: 1,
  observations: 1,
};

/** Pick top-N per kind, preserving the rank order. */
export function topNByKind(
  ranked: ReadonlyArray<RankedMemory>,
  caps: TopNCaps,
): ReadonlyArray<RankedMemory> {
  const counts: Record<MemoryKind, number> = {
    conclusion: 0,
    decision: 0,
    hypothesis: 0,
    verification: 0,
    observation: 0,
  };
  const out: RankedMemory[] = [];
  for (const r of ranked) {
    const cap = caps[r.kind === "conclusion"
      ? "conclusions"
      : r.kind === "decision"
        ? "decisions"
        : r.kind === "hypothesis"
          ? "hypotheses"
          : r.kind === "verification"
            ? "verifications"
            : "observations"];
    if (counts[r.kind] >= cap) continue;
    counts[r.kind] += 1;
    out.push(r);
  }
  return out;
}

/** Normalize free-form text for duplicate grouping. */
export function normalizeForDedup(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .sort()
    .join(" ");
}

/**
 * Collapse memories that express the same conclusion.
 * Preference order: verified > newer > accepted > first seen.
 * A rejected item only loses to a non-rejected twin — when it has
 * no twin it survives on its own (callers still want to surface
 * rejected memories for context).
 *
 * Kinds outside the dedup set (default: conclusion + decision)
 * pass through untouched — they never share a bucket with anything.
 */
export function deduplicateMemories(
  ranked: ReadonlyArray<RankedMemory>,
  opts: { readonly kinds?: ReadonlyArray<MemoryKind> } = {},
): ReadonlyArray<RankedMemory> {
  const kinds = new Set(opts.kinds ?? ["conclusion", "decision"]);
  const groups = new Map<string, RankedMemory[]>();
  const passthrough: RankedMemory[] = [];

  for (const m of ranked) {
    if (!kinds.has(m.kind)) {
      passthrough.push(m);
      continue;
    }
    const key = normalizeForDedup(m.text);
    if (key.length === 0) {
      passthrough.push(m);
      continue;
    }
    const bucket = groups.get(key) ?? [];
    bucket.push(m);
    groups.set(key, bucket);
  }

  // Trust-rank helper: lower number wins. Rejected ranks last so a
  // non-rejected twin always outranks it.
  const trustRank = (t: MemoryTrust): number => {
    if (t === "verified") return 0;
    if (t === "accepted") return 1;
    if (t === "pending") return 2;
    return 3;
  };

  const survivors: RankedMemory[] = [...passthrough];
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      survivors.push(bucket[0]!);
      continue;
    }
    // Sort: better trust first, then newer, then id tiebreak.
    const sorted = [...bucket].sort((a, b) => {
      const tr = trustRank(a.trust) - trustRank(b.trust);
      if (tr !== 0) return tr;
      if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
      return a.id.localeCompare(b.id);
    });
    // Pick the highest-ranked entry, but never drop a rejected twin
    // entirely — when ALL twins are rejected, keep them all (each is
    // its own reason for rejection).
    const top = sorted[0]!;
    const topTrust = trustRank(top.trust);
    const winner = topTrust <= 2 ? [top] : sorted;
    survivors.push(...winner);
  }
  // Preserve original rank order so downstream sort remains stable.
  const order = new Map(ranked.map((r, i) => [r.id, i]));
  survivors.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return survivors;
}
