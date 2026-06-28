/**
 * packages/recovery/src/recovery.ts — v0.2 recovery surface builder.
 *
 * Pure function: takes a SessionState plus the latest verification map
 * and a snapshot-or-replayed SessionState, returns the v0.2 envelope.
 *
 * No I/O. No Effect. No DB. The caller (apps/server route handler)
 * resolves the inputs once per request; this function maps them to
 * the 8-field v0.2 shape without coupling the recovery package to
 * `@cognit/db` (no cycle; db depends on core only, recovery depends
 * on core only).
 *
 * Placeholders wired by future beads:
 *   - related_sessions        — phase 7r.2 (fuzzy search)
 *
 * Phase 8 (8g.4) wires `suggested_next_steps`: the caller passes the
 * top-1 active hypothesis (id, text, score) computed via
 * `@cognit/gravity.rankHypotheses` so the recovery package never
 * imports the gravity engine directly.
 */
import type {
  HypothesisState,
  SessionState,
} from "@cognit/core/state";

/**
 * Summary of the most-recent verification event chain for one
 * hypothesis. `state` is the terminal lifecycle — `cancelled` if the
 * user killed it, `errored` if the spawn failed, otherwise `passed`
 * or `failed`. `started` is only present if no terminal event has
 * landed yet.
 */
export interface LatestVerification {
  readonly id: string;
  readonly hypothesis_id: string;
  readonly type: "test" | "lint" | "build" | "exec" | "typecheck";
  readonly command: string;
  readonly state:
    | "started"
    | "passed"
    | "failed"
    | "errored"
    | "cancelled";
  readonly started_at: string;
  readonly ended_at: string | null;
}

/**
 * Map from hypothesis id → latest verification summary. Missing
 * entries mean "no verification ever linked to this hypothesis". The
 * route resolves this map once per request via the new db selector.
 */
export type LatestVerifications = ReadonlyMap<string, LatestVerification>;

/** Inputs the route resolves before calling `buildRecovery`. */
export interface BuildRecoveryInput {
  readonly sessionId: string;
  readonly state: SessionState;
  /** Parsed `snapshot.state_json` if a snapshot exists; null if no snapshot. */
  readonly snapshotState: SessionState | null;
  readonly latestVerifications: LatestVerifications;
  /** Placeholder values, filled by future beads. Caller passes `[]` today. */
  readonly relatedSessions?: ReadonlyArray<RelatedSession>;
  /**
   * Phase 8 (8g.4): top-N suggested next steps. The route computes
   * `rankHypotheses(state, cfg, ...)` and passes the result here; the
   * recovery surface returns `suggestedNextSteps[0]` as a single-entry
   * array when one exists, otherwise an empty array.
   */
  readonly suggestedNextSteps?: ReadonlyArray<SuggestedNextStep>;
}

/** Placeholder shape — phase 7r.2 populates this via fuzzy search. */
export interface RelatedSession {
  readonly id: string;
  readonly score: number;
  readonly matched_on: string;
}

/**
 * Phase 8 (8g.4) suggested next step. The recovery surface returns
 * the single highest-ranked active hypothesis (id, text, score)
 * computed by `@cognit/gravity.rankHypotheses`. The route resolves
 * the ranked list once per request; the recovery package never
 * imports the gravity engine itself.
 */
export interface SuggestedNextStep {
  readonly id: string;
  readonly text: string;
  readonly score: number;
}

/** v0.2 recovery envelope — exactly 8 top-level fields. */
export interface RecoveryV02 {
  readonly session_id: string;
  readonly related_sessions: ReadonlyArray<RelatedSession>;
  readonly verified_conclusions: ReadonlyArray<VerifiedConclusion>;
  readonly rejected_hypotheses: ReadonlyArray<RejectedHypothesis>;
  readonly accepted_decisions: ReadonlyArray<AcceptedDecision>;
  readonly rejected_decisions: ReadonlyArray<RejectedDecision>;
  /** Keyed by hypothesis id. JSON-serialised as `Record<string, LatestVerification>` for the wire. */
  readonly latest_verification: ReadonlyMap<string, LatestVerification>;
  readonly last_known_state: SessionState;
  readonly suggested_next_steps: ReadonlyArray<SuggestedNextStep>;
}

export interface VerifiedConclusion {
  readonly id: string;
  readonly text: string;
  readonly verification_id: string | null;
  readonly supporting_evidence_ids: ReadonlyArray<string>;
  readonly created_at: string;
}

/**
 * Lightweight reference to an observation in the rejection sheet.
 * `ts` is the observation's `created_at` (ISO 8601). The recovery
 * surface joins `state.observations` to the `supports`/`contradicts`
 * edges pointing at the hypothesis (via the intermediate finding /
 * conclusion) and surfaces up to N rows per direction so the
 * dashboard's rejection-sheet has something concrete to render.
 */
export interface ObservationRef {
  readonly id: string;
  readonly text: string;
  readonly ts: string;
}

export interface RejectedHypothesis {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly reason: string | null;
  readonly reason_type: "evidence" | "superseded" | "constraint" | null;
  readonly superseded_by_id: string | null;
  readonly created_at: string;
  /**
   * Top-3 observations feeding findings/conclusions that `support`
   * this hypothesis via an `edge_created` event. Empty when no
   * `supports` edge points at the hypothesis from a finding or
   * conclusion that itself records observations.
   */
  readonly supporting_observations: ReadonlyArray<ObservationRef>;
  /**
   * Top-1 observation feeding findings/conclusions that `contradict`
   * this hypothesis. We surface only the strongest contradiction so
   * the rejection sheet stays focused on "the one thing that killed
   * it"; the supporting list gets more room because rejection often
   * has a single decisive counter-example plus several corroborating
   * positives. Empty when no `contradicts` edge exists.
   */
  readonly contradicting_observations: ReadonlyArray<ObservationRef>;
}

export interface AcceptedDecision {
  readonly id: string;
  readonly text: string;
  readonly based_on_conclusion_ids: ReadonlyArray<string>;
  readonly created_at: string;
}

export interface RejectedDecision {
  readonly id: string;
  readonly text: string;
  readonly reason: string;
  readonly created_at: string;
}

/**
 * Build the v0.2 recovery envelope. Pure function — same input
 * always produces the same output.
 *
 * Last known state precedence:
 *   1. `snapshotState` if the caller found a snapshot row.
 *   2. Otherwise the freshly-reduced `state` (the caller already
 *      applied the snapshot+tail replay in `SessionService.show`).
 *
 * The route never falls back to a hand-rolled replay here — that
 * would duplicate the reducer's behaviour.
 */
export const buildRecovery = (input: BuildRecoveryInput): RecoveryV02 => {
  const verified_conclusions: VerifiedConclusion[] = [];
  for (const c of input.state.conclusions.values()) {
    if (c.state !== "verified") continue;
    verified_conclusions.push({
      id: c.id,
      text: c.text,
      verification_id: c.verification_id,
      supporting_evidence_ids: c.supporting_evidence_ids,
      created_at: c.created_at,
    });
  }

  const rejected_hypotheses: RejectedHypothesis[] = [];
  for (const h of input.state.hypotheses.values()) {
    if (h.current_state !== "rejected") continue;
    const links = collectObservationLinks(h.id, input.state);
    rejected_hypotheses.push(
      toRejectedHypothesis(h, {
        supporting: links.supporting.slice(0, 3),
        contradicting: links.contradicting.slice(0, 1),
      }),
    );
  }

  const accepted_decisions: AcceptedDecision[] = [];
  const rejected_decisions: RejectedDecision[] = [];
  for (const d of input.state.decisions.values()) {
    if (d.state === "accepted") {
      accepted_decisions.push({
        id: d.id,
        text: d.text,
        based_on_conclusion_ids: d.based_on_conclusion_ids,
        created_at: d.created_at,
      });
    } else if (d.state === "rejected") {
      rejected_decisions.push({
        id: d.id,
        text: d.text,
        reason: d.reason ?? "",
        created_at: d.created_at,
      });
    }
  }

  // Filter latest_verification: only include entries for hypotheses
  // that exist in the current state. Stale ids (hypothesis since
  // deleted? not currently possible — hypotheses stay in state once
  // rejected, so this is defensive) would leak otherwise.
  const latest_verification = new Map<string, LatestVerification>();
  for (const h of input.state.hypotheses.keys()) {
    const v = input.latestVerifications.get(h);
    if (v) latest_verification.set(h, v);
  }

  return {
    session_id: input.sessionId,
    related_sessions: input.relatedSessions ?? [],
    verified_conclusions,
    rejected_hypotheses,
    accepted_decisions,
    rejected_decisions,
    latest_verification,
    last_known_state: input.snapshotState ?? input.state,
    // Phase 8 (8g.4): surface the single top-ranked active hypothesis
    // as the suggested next step. When the caller supplies an empty
    // ranked list (no active hypotheses, or gravity engine off), we
    // return an empty array so the wire shape stays a list.
    suggested_next_steps:
      input.suggestedNextSteps && input.suggestedNextSteps.length > 0
        ? [input.suggestedNextSteps[0]!]
        : [],
  };
};

const toRejectedHypothesis = (
  h: HypothesisState,
  links: {
    readonly supporting: ReadonlyArray<ObservationRef>;
    readonly contradicting: ReadonlyArray<ObservationRef>;
  },
): RejectedHypothesis => ({
  id: h.id,
  title: h.title,
  text: h.text,
  reason: h.current_reason,
  reason_type: h.reason_type,
  superseded_by_id: h.superseded_by_id,
  created_at: h.created_at,
  supporting_observations: links.supporting,
  contradicting_observations: links.contradicting,
});

/**
 * Resolve the supporting + contradicting observation lists for one
 * rejected hypothesis.
 *
 * Walk the directed edge set in `state.edges`:
 *   supports/contradicts:   finding|conclusion  →  hypothesis
 *   derived_from:          finding              →  observation|finding
 *   related_observation_ids (on FindingState): finding → observation
 *
 * For every supports edge pointing at the hypothesis we collect the
 * observation ids reachable through the source finding/conclusion
 * (via `derived_from` edges OR the finding's own
 * `related_observation_ids`). For every contradicts edge we do the
 * same. The lists are deduplicated, ordered by the originating edge's
 * `created_at` (oldest observation first), then capped at the desired
 * surface count (3 supporting, 1 contradicting) so the rejection
 * sheet's `slice(0, N)` matches what we ship over the wire.
 *
 * Pure — no I/O. Same input state always produces the same lists.
 */
const collectObservationLinks = (
  hypothesisId: string,
  state: SessionState,
): {
  readonly supporting: ReadonlyArray<ObservationRef>;
  readonly contradicting: ReadonlyArray<ObservationRef>;
} => {
  type Dir = "supports" | "contradicts";
  const collect = (dir: Dir): ReadonlyArray<ObservationRef> => {
    // 1. Find every supports/contradicts edge landing on this
    //    hypothesis from a finding or conclusion. Order by edge
    //    `created_at` ASC so the oldest observation wins ties.
    const relevant = state.edges
      .filter(
        (e) =>
          e.edge_type === dir &&
          e.to_entity_type === "hypothesis" &&
          e.to_entity_id === hypothesisId &&
          (e.from_entity_type === "finding" ||
            e.from_entity_type === "conclusion"),
      )
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (relevant.length === 0) return [];

    // 2. For each finding/conclusion, walk derived_from edges OR the
    //    finding's own related_observation_ids to get observation ids.
    //    We keep the originating edge's timestamp for ordering.
    type Hit = { ts: string; obsId: string };
    const hits: Hit[] = [];
    const seenObs = new Set<string>();
    for (const edge of relevant) {
      const obsIds: ReadonlyArray<string> = ((): ReadonlyArray<string> => {
        if (edge.from_entity_type === "finding") {
          const f = state.findings.find((x) => x.id === edge.from_entity_id);
          if (f) return f.related_observation_ids;
        }
        // Conclusion → observation only via a derived_from edge.
        if (edge.from_entity_type === "conclusion") {
          return state.edges
            .filter(
              (de) =>
                de.edge_type === "derived_from" &&
                de.from_entity_type === "conclusion" &&
                de.from_entity_id === edge.from_entity_id &&
                de.to_entity_type === "observation",
            )
            .map((de) => de.to_entity_id);
        }
        return [];
      })();
      for (const obsId of obsIds) {
        if (seenObs.has(obsId)) continue;
        seenObs.add(obsId);
        hits.push({ ts: edge.created_at, obsId });
      }
    }

    // 3. Resolve observation ids to ObservationRef rows. Keep order.
    const out: ObservationRef[] = [];
    for (const h of hits) {
      const o = state.observations.find((x) => x.id === h.obsId);
      if (!o) continue;
      out.push({ id: o.id, text: o.text, ts: o.created_at });
    }
    return out;
  };

  return {
    supporting: collect("supports"),
    contradicting: collect("contradicts"),
  };
};

/**
 * Wire serialisation. `Map` is not JSON-native; convert to a plain
 * record so the API consumer sees `{ "<hypothesisId>": {...} }`.
 * The recovery package keeps the typed `Map` internally; the route
 * calls this just before `c.json(envelope(...))`.
 */
export const serialiseLatestVerification = (
  m: ReadonlyMap<string, LatestVerification>,
): Record<string, LatestVerification> => {
  const out: Record<string, LatestVerification> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
};
