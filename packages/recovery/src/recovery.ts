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
 *   - suggested_next_steps     — phase 8 (gravity engine)
 *
 * In this bead both fields are empty arrays. The shape is locked so
 * the route can serialise it without conditional branches; later beads
 * extend the resolver that feeds them.
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
}

/** Placeholder shape — phase 7r.2 populates this via fuzzy search. */
export interface RelatedSession {
  readonly id: string;
  readonly score: number;
  readonly matched_on: string;
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
  readonly suggested_next_steps: ReadonlyArray<unknown>;
}

export interface VerifiedConclusion {
  readonly id: string;
  readonly text: string;
  readonly verification_id: string | null;
  readonly supporting_evidence_ids: ReadonlyArray<string>;
  readonly created_at: string;
}

export interface RejectedHypothesis {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly reason: string | null;
  readonly reason_type: "evidence" | "superseded" | "constraint" | null;
  readonly superseded_by_id: string | null;
  readonly created_at: string;
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
    rejected_hypotheses.push(toRejectedHypothesis(h));
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
    suggested_next_steps: [],
  };
};

const toRejectedHypothesis = (h: HypothesisState): RejectedHypothesis => ({
  id: h.id,
  title: h.title,
  text: h.text,
  reason: h.current_reason,
  reason_type: h.reason_type,
  superseded_by_id: h.superseded_by_id,
  created_at: h.created_at,
});

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
