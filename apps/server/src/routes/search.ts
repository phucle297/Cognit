/**
 * apps/server/src/routes/search.ts — `GET /api/sessions/search`
 *
 * Fuzzy keyword search over session content per phase 7r.2.
 *
 * Scope (AC-7.2): ONLY goals, findings, hypotheses, decisions, and
 * conclusions. Observation payloads, event payloads, artifact
 * contents, and redaction metadata are NEVER indexed.
 *
 * Weights (per task spec):
 *   goals       [3]
 *   findings    [2]
 *   hypotheses  [2]
 *   decisions   [2]
 *   conclusions [2]
 *
 * Filters (AC-7.3, AND-combined): status, project, min_confidence.
 *
 * Determinism (AC-7.19): fuse.js with a fixed `threshold` and
 * `distance` plus stable sort by `score` then `(kind, session_id,
 * id)`. No randomness.
 *
 * Redaction safety (AC-7.20): index entries are derived from
 * `SessionService.show`, whose `state` is the redacted shape.
 * The route never reads `events.payload_json` directly.
 *
 * Wiring to 7r.1: the same fuzzy engine also fills
 * `related_sessions` in the recovery envelope (called from the
 * recovery handler, not from this file).
 */
import Fuse from "fuse.js";
import { Effect } from "effect";
import { Hono } from "hono";
import { SessionService } from "@cognit/db";
import type { SessionState } from "@cognit/core/state";
import { envelope } from "../envelope.js";
import { apiErrorResponse } from "../api-error.js";
import type { ServerRuntime } from "./sessions.js";

export interface SearchRouteDeps {
  readonly runtime: ServerRuntime;
  readonly projectId: string;
}

type SearchKind = "goal" | "finding" | "hypothesis" | "decision" | "conclusion";

interface IndexEntry {
  readonly id: string; // unique within session: `${kind}:${entityId}`
  readonly kind: SearchKind;
  readonly session_id: string;
  readonly project_id: string;
  readonly status: "active" | "paused" | "closed";
  readonly confidence: number | null; // hypothesis only
  // The text the route actually searches on. Per-kind weighted
  // scoring is achieved by emitting the entry into one of the
  // five `text_<kind>` slots (fuse multi-key weights), so the
  // `_search_text` is the union for ad-hoc comparisons.
  readonly text: string;
  // Per-kind weighted fields. Only the field matching `kind` is
  // populated; the others stay empty strings so they do not match.
  readonly text_goal: string;
  readonly text_finding: string;
  readonly text_hypothesis: string;
  readonly text_decision: string;
  readonly text_conclusion: string;
}

const KIND_WEIGHT: Readonly<Record<SearchKind, number>> = {
  goal: 3,
  finding: 2,
  hypothesis: 2,
  decision: 2,
  conclusion: 2,
};

export interface RelatedSessionMatch {
  readonly id: string;
  readonly score: number;
  readonly matched_on: string;
}

/**
 * Build an in-memory index from a SessionState. Called once per
 * session in the result set. Pure function — no I/O, no DB.
 */
export const indexSession = (
  sessionId: string,
  projectId: string,
  status: "active" | "paused" | "closed",
  state: SessionState,
): ReadonlyArray<IndexEntry> => {
  const out: IndexEntry[] = [];
  const empty = {
    text_goal: "",
    text_finding: "",
    text_hypothesis: "",
    text_decision: "",
    text_conclusion: "",
  };
  out.push({
    id: `goal:${sessionId}`,
    kind: "goal",
    session_id: sessionId,
    project_id: projectId,
    status,
    confidence: null,
    text: state.goal,
    ...empty,
    text_goal: state.goal,
  });
  for (const f of state.findings.values()) {
    out.push({
      id: `finding:${f.id}`,
      kind: "finding",
      session_id: sessionId,
      project_id: projectId,
      status,
      confidence: null,
      text: f.text,
      ...empty,
      text_finding: f.text,
    });
  }
  for (const h of state.hypotheses.values()) {
    out.push({
      id: `hypothesis:${h.id}`,
      kind: "hypothesis",
      session_id: sessionId,
      project_id: projectId,
      status,
      confidence: h.current_confidence,
      text: h.text,
      ...empty,
      text_hypothesis: h.text,
    });
  }
  for (const d of state.decisions.values()) {
    out.push({
      id: `decision:${d.id}`,
      kind: "decision",
      session_id: sessionId,
      project_id: projectId,
      status,
      confidence: null,
      text: d.text,
      ...empty,
      text_decision: d.text,
    });
  }
  for (const c of state.conclusions.values()) {
    out.push({
      id: `conclusion:${c.id}`,
      kind: "conclusion",
      session_id: sessionId,
      project_id: projectId,
      status,
      confidence: null,
      text: c.text,
      ...empty,
      text_conclusion: c.text,
    });
  }
  return out;
};

/**
 * Run a fuzzy search against an index. Returns ranked entries
 * with their fuse score (lower = better; fuse inverts to a 0..1
 * confidence via `1 - score` for the wire). Deterministic sort
 * breaks ties by (kind, session_id, id).
 *
 * `min_confidence` is applied AFTER fuse scoring so a fuzzy match
 * whose underlying hypothesis has low confidence is filtered out
 * only when the caller asks for it.
 */
export const runSearch = (
  index: ReadonlyArray<IndexEntry>,
  q: string,
  opts: {
    readonly status?: "active" | "paused" | "closed";
    readonly project?: string;
    readonly minConfidence?: number;
    readonly limit: number;
    readonly offset: number;
  },
): ReadonlyArray<{
  readonly entry: IndexEntry;
  readonly score: number;
}> => {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [];

  // Build the fuse index. Threshold 0.4 plus `ignoreLocation` lets
  // single-token queries find matches anywhere in the indexed text
  // (AC-7.17: a single-char typo on a 4+ char term still matches).
  // For multi-token composite queries (e.g. the recovery handler's
  // session goal) we tokenise and search each significant token
  // independently so a long goal can still surface a session that
  // shares one distinctive word.
  //
  // Weights per task spec: goals[3], findings[2], hypotheses[2],
  // decisions[2], conclusions[2]. Implemented via 5 separate keys
  // — each entry populates exactly one `text_<kind>` slot and leaves
  // the others empty so they never match.
  const fuseOptions = {
    keys: [
      { name: "text_goal", weight: 3 },
      { name: "text_finding", weight: 2 },
      { name: "text_hypothesis", weight: 2 },
      { name: "text_decision", weight: 2 },
      { name: "text_conclusion", weight: 2 },
    ],
    includeScore: true,
    threshold: 0.4,
    distance: 100,
    ignoreLocation: true,
    minMatchCharLength: 2,
  };

  // Tokenise the query. Fuse treats the full string as the pattern;
  // for a 3-word query like "investigate XYZUNIQ regression" only
  // entries containing that exact substring (or a fuzzy match
  // against the whole string) survive the threshold. We split on
  // non-word boundaries and search each token ≥ 3 chars
  // independently, then dedupe by entry id keeping the best score.
  const tokens = trimmed
    .split(/[^A-Za-z0-9_-]+/)
    .filter((t) => t.length >= 3);
  const queries = tokens.length > 1 ? tokens : [trimmed];

  const raw: Array<{ item: IndexEntry; score: number }> = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const fuse = new Fuse(index as IndexEntry[], fuseOptions);
    for (const r of fuse.search(q)) {
      if (seen.has(r.item.id)) continue;
      seen.add(r.item.id);
      raw.push({ item: r.item, score: r.score ?? 1 });
    }
  }

  const filtered = raw.filter((r) => {
    const e = r.item;
    if (opts.status !== undefined && e.status !== opts.status) return false;
    if (opts.project !== undefined && e.project_id !== opts.project)
      return false;
    if (
      opts.minConfidence !== undefined &&
      e.confidence !== null &&
      e.confidence < opts.minConfidence
    ) {
      return false;
    }
    return true;
  });

  // Stable tiebreak: lower fuse score wins; if equal, the
  // (kind, session_id, id) lex order wins.
  const ranked = filtered
    .map((r) => ({ entry: r.item, score: r.score ?? 1 }))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const k = a.entry.kind.localeCompare(b.entry.kind);
      if (k !== 0) return k;
      const s = a.entry.session_id.localeCompare(b.entry.session_id);
      if (s !== 0) return s;
      return a.entry.id.localeCompare(b.entry.id);
    });

  const start = Math.max(0, opts.offset);
  const end = start + Math.max(1, opts.limit);
  return ranked.slice(start, end);
};

/**
 * Group ranked entries by session_id. Used by the recovery
 * handler to fill `related_sessions`: each session appears at
 * most once, with its best match's score and the matched kind.
 */
export const groupBySession = (
  ranked: ReadonlyArray<{ entry: IndexEntry; score: number }>,
  _q: string,
): ReadonlyArray<RelatedSessionMatch> => {
  const best = new Map<
    string,
    { score: number; kind: SearchKind; text: string }
  >();
  for (const r of ranked) {
    const cur = best.get(r.entry.session_id);
    if (cur === undefined || r.score < cur.score) {
      best.set(r.entry.session_id, {
        score: r.score,
        kind: r.entry.kind,
        text: r.entry.text,
      });
    }
  }
  return Array.from(best.entries())
    .map(([id, v]) => ({
      id,
      score: Math.max(0, 1 - v.score),
      matched_on: `${v.kind}: ${v.text.slice(0, 80)}`,
    }))
    .sort((a, b) => b.score - a.score);
};

/**
 * Register the search route. Pure side effect: attaches handlers
 * to the Hono app.
 */
export const registerSearchRoutes = (
  app: Hono,
  deps: SearchRouteDeps,
): void => {
  const { runtime, projectId } = deps;

  app.get("/api/sessions/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const status = c.req.query("status");
    const project = c.req.query("project");
    const minConfidenceRaw = c.req.query("min_confidence");
    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");

    if (q.trim().length === 0) {
      return apiErrorResponse(
        c,
        "validation_failed",
        "search: 'q' must be non-empty",
      );
    }
    const limit = clampInt(limitRaw, 1, 200, 50);
    const offset = clampInt(offsetRaw, 0, 10_000, 0);
    const minConfidence =
      minConfidenceRaw !== undefined && minConfidenceRaw !== ""
        ? Number(minConfidenceRaw)
        : undefined;
    if (minConfidence !== undefined && Number.isNaN(minConfidence)) {
      return apiErrorResponse(
        c,
        "validation_failed",
        "search: min_confidence must be numeric",
      );
    }
    if (
      status !== undefined &&
      status !== "active" &&
      status !== "paused" &&
      status !== "closed"
    ) {
      return apiErrorResponse(
        c,
        "validation_failed",
        "search: status must be one of active|paused|closed",
      );
    }

    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      const sessions = yield* service.list({ projectId });
      // Pull the full state for every candidate. Local-only tool,
      // bounded list — N is small. If a future caller hits a 10k+
      // session repo, switch this to an indexed column on the
      // event-store payload.
      const states: Array<{
        sessionId: string;
        projectId: string;
        status: "active" | "paused" | "closed";
        state: SessionState;
      }> = [];
      for (const s of sessions) {
        const show = yield* service.show(s.id);
        states.push({
          sessionId: s.id,
          projectId: s.project_id,
          status: s.status,
          state: show.state,
        });
      }
      return states;
    });

    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<unknown, unknown, never>,
    );
    if (exit._tag === "Failure") {
      return apiErrorResponse(c, "internal", "search: list+show failed");
    }
    const states = (exit as { value: Array<{
      sessionId: string;
      projectId: string;
      status: "active" | "paused" | "closed";
      state: SessionState;
    }> }).value;

    const index: IndexEntry[] = [];
    for (const s of states) {
      for (const entry of indexSession(
        s.sessionId,
        s.projectId,
        s.status,
        s.state,
      )) {
        index.push(entry);
      }
    }

    const ranked = runSearch(index, q, {
      ...(status !== undefined ? { status: status as "active" | "paused" | "closed" } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(minConfidence !== undefined ? { minConfidence } : {}),
      limit,
      offset,
    });

    const results = ranked.map((r) => ({
      session_id: r.entry.session_id,
      kind: r.entry.kind,
      entity_id: r.entry.id.split(":")[1] ?? r.entry.id,
      score: Math.max(0, 1 - r.score),
      text: r.entry.text,
      kind_weight: KIND_WEIGHT[r.entry.kind],
    }));

    return c.json(envelope("sessions.search", { q, results, limit, offset }));
  });
};

const clampInt = (
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
};
