/**
 * Pure reducer: fold a session's events into a `SessionState`.
 *
 * The reducer is a TOTAL function over `EventRow[]` — every event type
 * has a branch in `applyEvent`, even non-state events which simply
 * leave the state unchanged. This is the contract: the caller can hand
 * us an unfiltered event log and we'll never throw, never silently drop
 * a transition.
 *
 * Ordering: events are sorted by `(created_at ASC, id ASC)` before
 * fold. ULIDs are monotonic, so id-sorting is a stable tiebreaker for
 * events with the same millisecond.
 *
 * Snapshot restore: when `initial` is provided, we treat it as the
 * state after `initial.snapshot_event_id` was applied, and apply only
 * events whose `id` sorts strictly after it. This makes the reducer
 * usable for both cold-start replay and snapshot+tail rebuild.
 *
 * State-machine resolution: events that don't carry an entity id in
 * their payload (e.g. `hypothesis_weakened`) apply to the session-scoped
 * `current_*` pointer the reducer maintains. The pointer advances on
 * `*_created` / `*_proposed` / `verification_started` events. This is
 * the most natural reading of `plan.xml`'s event catalog given the
 * absence of a generic `entity_id` column on `events`.
 */

import {
  type ArtifactRole,
  type ConclusionLifecycle,
  type EdgeState,
  emptySessionState,
  type HypothesisLifecycle,
  type ReducerEvent,
  type RejectReasonType,
  type SessionLifecycle,
  type SessionState,
  type VerificationKind,
  type VerificationLifecycle,
} from "./state.js";

/** Event types the reducer actively folds into state. */
const STATE_EVENT_TYPES = new Set<string>([
  "session_created",
  "session_paused",
  "session_closed",
  "observation_recorded",
  "finding_created",
  "hypothesis_created",
  "hypothesis_weakened",
  "hypothesis_rejected",
  "hypothesis_promoted",
  "theory_created",
  "theory_updated",
  "theory_merged",
  "theory_archived",
  "experiment_created",
  "experiment_completed",
  "decision_proposed",
  "decision_accepted",
  "decision_rejected",
  "decision_superseded",
  "conclusion_proposed",
  "conclusion_verified",
  "conclusion_rejected",
  "verification_started",
  "verification_passed",
  "verification_failed",
  "verification_errored",
  "verification_cancelled",
  "verification_rerun",
  "artifact_attached",
  "edge_created",
]);

const NON_STATE_EVENT_TYPES = new Set<string>([
  "project_created",
  "actor_registered",
  "redaction_applied",
  "constraint_rule_added",
  "constraint_rule_applied",
  "snapshot_created",
]);

const ALL_KNOWN_TYPES: ReadonlySet<string> = new Set([
  ...STATE_EVENT_TYPES,
  ...NON_STATE_EVENT_TYPES,
]);

/**
 * Sort events into replay order: ascending `(created_at, id)`.
 *
 * ULID ids are monotonic and 26 chars, so a string compare is a correct
 * chronological tiebreaker for events with the same `created_at`.
 */
export const sortEvents = (events: ReadonlyArray<ReducerEvent>): ReducerEvent[] => {
  const copy = events.slice();
  copy.sort((a, b) => {
    if (a.created_at < b.created_at) return -1;
    if (a.created_at > b.created_at) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return copy;
};

/** Defensive JSON parse: returns null on bad payload rather than throwing. */
const safeParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const getString = (o: unknown, key: string): string | null => {
  if (!o || typeof o !== "object") return null;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
};

const getStringArray = (o: unknown, key: string): ReadonlyArray<string> => {
  if (!o || typeof o !== "object") return [];
  const v = (o as Record<string, unknown>)[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
};

/**
 * Read a finite numeric field from a payload object. Returns `null`
 * for missing / non-numeric / NaN / Infinity values — v1.1.0 outcome
 * fields are nullable on disk, so the reducer treats unknown as
 * "not recorded".
 */
const getNumber = (o: unknown, key: string): number | null => {
  if (!o || typeof o !== "object") return null;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

const isVerificationKind = (s: string): s is VerificationKind =>
  s === "test" || s === "lint" || s === "build" || s === "exec" || s === "typecheck";

const isArtifactRole = (s: string): s is ArtifactRole =>
  s === "evidence" || s === "code" || s === "log" || s === "config";

const isRejectReason = (s: string): s is RejectReasonType =>
  s === "evidence" || s === "superseded" || s === "constraint";

const isHypothesisLifecycle = (s: string): s is HypothesisLifecycle =>
  s === "active" || s === "weakened" || s === "rejected" || s === "promoted";

const isConclusionLifecycle = (s: string): s is ConclusionLifecycle =>
  s === "unverified" || s === "verified" || s === "rejected";

const isVerificationLifecycle = (s: string): s is VerificationLifecycle =>
  s === "started" || s === "passed" || s === "failed" || s === "errored" || s === "cancelled";

const isSessionLifecycle = (s: string): s is SessionLifecycle =>
  s === "active" || s === "paused" || s === "closed";

/** Fold a single event into a new state. Pure, never mutates input. */
export const applyEvent = (state: SessionState, event: ReducerEvent): SessionState => {
  // Always append to timeline. The timeline is the read view of the
  // log itself, so it includes non-state events.
  const timeline: ReadonlyArray<ReducerEvent> = [...state.timeline, event];

  // Non-state events: append timeline + advance the last-event pointer.
  if (!STATE_EVENT_TYPES.has(event.type)) {
    return {
      ...state,
      timeline,
      last_event_id: event.id,
      last_event_at: event.created_at,
    };
  }

  const payload = safeParse(event.payload_json) ?? {};
  const next: SessionState = { ...state, timeline };

  switch (event.type) {
    case "session_created": {
      const goal = getString(payload, "goal") ?? state.goal;
      const parent = getString(payload, "parent_session_id") ?? state.parent_session_id;
      return {
        ...next,
        goal,
        parent_session_id: parent,
        status: "active",
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
    }
    case "session_paused":
      return {
        ...next,
        status: "paused",
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
    case "session_closed":
      return {
        ...next,
        status: "closed",
        last_event_id: event.id,
        last_event_at: event.created_at,
      };

    case "observation_recorded": {
      const text = getString(payload, "text") ?? "";
      const obs = {
        id: event.id,
        text,
        created_at: event.created_at,
        last_event_id: event.id,
      };
      return { ...next, observations: [...state.observations, obs] };
    }
    case "finding_created": {
      const text = getString(payload, "text") ?? "";
      const related = getStringArray(payload, "related_observation_ids");
      const finding = {
        id: event.id,
        text,
        related_observation_ids: related,
        created_at: event.created_at,
        last_event_id: event.id,
      };
      return { ...next, findings: [...state.findings, finding] };
    }

    case "hypothesis_created": {
      const title = getString(payload, "title") ?? "";
      const text = getString(payload, "text") ?? "";
      // Backfill gravity_fired_at to the event's created_at, in epoch
      // seconds. ISO 8601 -> epoch conversion: divide the millisecond
      // timestamp by 1000. We tolerate a malformed created_at by
      // defaulting to 0 (the "never fired" sentinel), which makes the
      // hypothesis score 0 on freshness — the safe side.
      const createdMs = Date.parse(event.created_at);
      const firedAtSec = Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : 0;
      const h: import("./state.js").HypothesisState = {
        id: event.id,
        title,
        text,
        current_state: "active",
        current_confidence: event.confidence,
        current_reason: null,
        reason_type: null,
        superseded_by_id: null,
        promoted_to_theory_id: null,
        belongs_to_theory_id: null,
        created_at: event.created_at,
        last_event_id: event.id,
        last_event_at: event.created_at,
        gravity_fired_at: firedAtSec,
      };
      const hypotheses = new Map(state.hypotheses);
      hypotheses.set(event.id, h);
      return {
        ...next,
        hypotheses,
        current_hypothesis_id: event.id,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
    }
    case "hypothesis_weakened": {
      const id = state.current_hypothesis_id;
      if (id === null) return next;
      const cur = state.hypotheses.get(id);
      if (!cur || !isHypothesisLifecycle(cur.current_state)) return next;
      if (cur.current_state === "rejected" || cur.current_state === "promoted") {
        // terminal state; no further transitions accepted
        return next;
      }
      const reason = getString(payload, "reason");
      const updated: import("./state.js").HypothesisState = {
        ...cur,
        current_state: "weakened",
        current_confidence: event.confidence ?? cur.current_confidence,
        current_reason: reason,
        reason_type: cur.reason_type,
        superseded_by_id: cur.superseded_by_id,
        promoted_to_theory_id: cur.promoted_to_theory_id,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const hypotheses = new Map(state.hypotheses);
      hypotheses.set(id, updated);
      return { ...next, hypotheses };
    }
    case "hypothesis_rejected": {
      const id = state.current_hypothesis_id;
      if (id === null) return next;
      const cur = state.hypotheses.get(id);
      if (!cur) return next;
      if (cur.current_state === "rejected" || cur.current_state === "promoted") return next;
      const reasonTypeStr = getString(payload, "reason_type") ?? "evidence";
      const reasonType = isRejectReason(reasonTypeStr) ? reasonTypeStr : "evidence";
      const supersededBy = getString(payload, "superseded_by_id");
      const updated: import("./state.js").HypothesisState = {
        ...cur,
        current_state: "rejected",
        current_confidence: event.confidence ?? cur.current_confidence,
        current_reason: reasonType,
        reason_type: reasonType,
        superseded_by_id: supersededBy,
        promoted_to_theory_id: cur.promoted_to_theory_id,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const hypotheses = new Map(state.hypotheses);
      hypotheses.set(id, updated);
      return { ...next, hypotheses };
    }
    case "hypothesis_promoted": {
      const id = state.current_hypothesis_id;
      if (id === null) return next;
      const cur = state.hypotheses.get(id);
      if (!cur) return next;
      if (cur.current_state === "rejected" || cur.current_state === "promoted") return next;
      const promotedTo = getString(payload, "promoted_to_theory_id");
      const updated: import("./state.js").HypothesisState = {
        ...cur,
        current_state: "promoted",
        current_confidence: event.confidence ?? cur.current_confidence,
        current_reason: null,
        reason_type: null,
        superseded_by_id: cur.superseded_by_id,
        promoted_to_theory_id: promotedTo,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const hypotheses = new Map(state.hypotheses);
      hypotheses.set(id, updated);
      return { ...next, hypotheses };
    }

    case "theory_created": {
      const title = getString(payload, "title") ?? "";
      const text = getString(payload, "text") ?? "";
      const t: import("./state.js").TheoryState = {
        id: event.id,
        title,
        text,
        hypothesis_ids: [],
        merged_into_theory_id: null,
        archived: false,
        created_at: event.created_at,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const theories = new Map(state.theories);
      theories.set(event.id, t);
      return {
        ...next,
        theories,
        current_theory_id: event.id,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
    }
    case "theory_updated": {
      const id = state.current_theory_id;
      if (id === null) return next;
      const cur = state.theories.get(id);
      if (!cur) return next;
      const text = getString(payload, "text") ?? cur.text;
      const updated: import("./state.js").TheoryState = {
        ...cur,
        text,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const theories = new Map(state.theories);
      theories.set(id, updated);
      return { ...next, theories };
    }
    case "theory_merged": {
      const id = state.current_theory_id;
      if (id === null) return next;
      const cur = state.theories.get(id);
      if (!cur) return next;
      const mergedInto = getString(payload, "merged_into_theory_id");
      const updated: import("./state.js").TheoryState = {
        ...cur,
        merged_into_theory_id: mergedInto,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const theories = new Map(state.theories);
      theories.set(id, updated);
      return { ...next, theories };
    }
    case "theory_archived": {
      const id = state.current_theory_id;
      if (id === null) return next;
      const cur = state.theories.get(id);
      if (!cur) return next;
      const updated: import("./state.js").TheoryState = {
        ...cur,
        archived: true,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const theories = new Map(state.theories);
      theories.set(id, updated);
      return { ...next, theories };
    }

    case "experiment_created": {
      const testsId = getString(payload, "tests_hypothesis_id") ?? "";
      const design = getString(payload, "design") ?? "";
      const e: import("./state.js").ExperimentState = {
        id: event.id,
        design,
        tests_hypothesis_id: testsId,
        completed: false,
        result_summary: null,
        supports: [],
        contradicts: [],
        created_at: event.created_at,
        completed_at: null,
        last_event_id: event.id,
      };
      const experiments = new Map(state.experiments);
      experiments.set(event.id, e);
      return { ...next, experiments };
    }
    case "experiment_completed": {
      // experiment_completed does not carry an experiment_id; convention
      // is the most recent experiment_created in the session. We pick
      // by created_at proximity: the last one we have seen.
      let target: string | null = null;
      for (const [id, e] of state.experiments) {
        if (e.completed) continue;
        if (target === null) {
          target = id;
          continue;
        }
        const cur = state.experiments.get(target);
        if (!cur) {
          target = id;
          continue;
        }
        if (e.created_at > cur.created_at) target = id;
      }
      if (target === null) return next;
      const cur = state.experiments.get(target);
      if (!cur) return next;
      const summary = getString(payload, "result_summary") ?? "";
      const supports = getStringArray(payload, "supports");
      const contradicts = getStringArray(payload, "contradicts");
      const updated: import("./state.js").ExperimentState = {
        ...cur,
        completed: true,
        result_summary: summary,
        supports,
        contradicts,
        completed_at: event.created_at,
        last_event_id: event.id,
      };
      const experiments = new Map(state.experiments);
      experiments.set(target, updated);
      return { ...next, experiments };
    }

    case "decision_proposed": {
      const text = getString(payload, "text") ?? "";
      const based = getStringArray(payload, "based_on_conclusion_ids");
      const d: import("./state.js").DecisionState = {
        id: event.id,
        text,
        state: "proposed",
        based_on_conclusion_ids: based,
        reason: null,
        superseded_by_decision_id: null,
        created_at: event.created_at,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const decisions = new Map(state.decisions);
      decisions.set(event.id, d);
      return {
        ...next,
        decisions,
        current_decision_id: event.id,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
    }
    case "decision_accepted": {
      const id = state.current_decision_id;
      if (id === null) return next;
      const cur = state.decisions.get(id);
      if (!cur) return next;
      if (cur.state === "accepted" || cur.state === "rejected" || cur.state === "superseded") {
        return next;
      }
      const based = getStringArray(payload, "based_on_conclusion_ids");
      const updated: import("./state.js").DecisionState = {
        ...cur,
        state: "accepted",
        based_on_conclusion_ids: based.length > 0 ? based : cur.based_on_conclusion_ids,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const decisions = new Map(state.decisions);
      decisions.set(id, updated);
      return { ...next, decisions };
    }
    case "decision_rejected": {
      const id = state.current_decision_id;
      if (id === null) return next;
      const cur = state.decisions.get(id);
      if (!cur) return next;
      if (cur.state === "accepted" || cur.state === "rejected" || cur.state === "superseded") {
        return next;
      }
      const reason = getString(payload, "reason");
      const updated: import("./state.js").DecisionState = {
        ...cur,
        state: "rejected",
        reason,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const decisions = new Map(state.decisions);
      decisions.set(id, updated);
      return { ...next, decisions };
    }
    case "decision_superseded": {
      const id = state.current_decision_id;
      if (id === null) return next;
      const cur = state.decisions.get(id);
      if (!cur) return next;
      const supersededBy = getString(payload, "superseded_by_decision_id");
      const updated: import("./state.js").DecisionState = {
        ...cur,
        state: "superseded",
        superseded_by_decision_id: supersededBy,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const decisions = new Map(state.decisions);
      decisions.set(id, updated);
      return { ...next, decisions };
    }

    case "conclusion_proposed": {
      const text = getString(payload, "text") ?? "";
      const c: import("./state.js").ConclusionState = {
        id: event.id,
        text,
        state: "unverified",
        verification_id: null,
        supporting_evidence_ids: [],
        reason: null,
        created_at: event.created_at,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const conclusions = new Map(state.conclusions);
      conclusions.set(event.id, c);
      return {
        ...next,
        conclusions,
        current_conclusion_id: event.id,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
    }
    case "conclusion_verified": {
      const id = state.current_conclusion_id;
      if (id === null) return next;
      const cur = state.conclusions.get(id);
      if (!cur) return next;
      if (cur.state === "verified" || cur.state === "rejected") return next;
      const vid = getString(payload, "verification_id");
      const evidence = getStringArray(payload, "supporting_evidence_ids");
      const updated: import("./state.js").ConclusionState = {
        ...cur,
        state: "verified",
        verification_id: vid,
        supporting_evidence_ids: evidence,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const conclusions = new Map(state.conclusions);
      conclusions.set(id, updated);
      return { ...next, conclusions };
    }
    case "conclusion_rejected": {
      const id = state.current_conclusion_id;
      if (id === null) return next;
      const cur = state.conclusions.get(id);
      if (!cur) return next;
      if (cur.state === "verified" || cur.state === "rejected") return next;
      const reason = getString(payload, "reason");
      const updated: import("./state.js").ConclusionState = {
        ...cur,
        state: "rejected",
        reason,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
      const conclusions = new Map(state.conclusions);
      conclusions.set(id, updated);
      return { ...next, conclusions };
    }

    case "verification_started": {
      const command = getString(payload, "command") ?? "";
      const typeStr = getString(payload, "type") ?? "exec";
      const type: VerificationKind = isVerificationKind(typeStr) ? typeStr : "exec";
      const linked = getString(payload, "linked_hypothesis_id");
      const expected_duration_ms = getNumber(payload, "expected_duration_ms");
      const v: import("./state.js").VerificationState = {
        id: event.id,
        command,
        type,
        linked_hypothesis_id: linked,
        state: "started",
        stderr_excerpt: null,
        error: null,
        parent_verification_id: null,
        started_at: event.created_at,
        ended_at: null,
        expected_duration_ms,
        duration_ms: null,
        exit_code: null,
        stdout_excerpt: null,
        created_artifact_id: null,
        last_event_id: event.id,
      };
      const verifications = new Map(state.verifications);
      verifications.set(event.id, v);
      return {
        ...next,
        verifications,
        current_verification_id: event.id,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
    }
    case "verification_passed": {
      const id = state.current_verification_id;
      if (id === null) return next;
      const cur = state.verifications.get(id);
      if (!cur) return next;
      if (cur.state !== "started") return next;
      const exit_code = getNumber(payload, "exit_code");
      const duration_ms = getNumber(payload, "duration_ms");
      const stdout_excerpt = getString(payload, "stdout_excerpt");
      const created_artifact_id = getString(payload, "created_artifact_id");
      const updated: import("./state.js").VerificationState = {
        ...cur,
        state: "passed",
        ended_at: event.created_at,
        exit_code,
        duration_ms,
        stdout_excerpt,
        created_artifact_id,
        last_event_id: event.id,
      };
      const verifications = new Map(state.verifications);
      verifications.set(id, updated);
      return { ...next, verifications, current_verification_id: null };
    }
    case "verification_failed": {
      const id = state.current_verification_id;
      if (id === null) return next;
      const cur = state.verifications.get(id);
      if (!cur) return next;
      if (cur.state !== "started") return next;
      const stderr = getString(payload, "stderr_excerpt");
      const exit_code = getNumber(payload, "exit_code");
      const duration_ms = getNumber(payload, "duration_ms");
      const stdout_excerpt = getString(payload, "stdout_excerpt");
      const created_artifact_id = getString(payload, "created_artifact_id");
      const updated: import("./state.js").VerificationState = {
        ...cur,
        state: "failed",
        stderr_excerpt: stderr,
        ended_at: event.created_at,
        exit_code,
        duration_ms,
        stdout_excerpt,
        created_artifact_id,
        last_event_id: event.id,
      };
      const verifications = new Map(state.verifications);
      verifications.set(id, updated);
      return { ...next, verifications, current_verification_id: null };
    }
    case "verification_errored": {
      const id = state.current_verification_id;
      if (id === null) return next;
      const cur = state.verifications.get(id);
      if (!cur) return next;
      if (cur.state !== "started") return next;
      const err = getString(payload, "error");
      const duration_ms = getNumber(payload, "duration_ms");
      const updated: import("./state.js").VerificationState = {
        ...cur,
        state: "errored",
        error: err,
        ended_at: event.created_at,
        duration_ms,
        last_event_id: event.id,
      };
      const verifications = new Map(state.verifications);
      verifications.set(id, updated);
      return { ...next, verifications, current_verification_id: null };
    }
    case "verification_cancelled": {
      const id = state.current_verification_id;
      if (id === null) return next;
      const cur = state.verifications.get(id);
      if (!cur) return next;
      if (cur.state !== "started") return next;
      const reason = getString(payload, "reason");
      const duration_ms = getNumber(payload, "duration_ms");
      const updated: import("./state.js").VerificationState = {
        ...cur,
        state: "cancelled",
        error: reason,
        ended_at: event.created_at,
        duration_ms,
        last_event_id: event.id,
      };
      const verifications = new Map(state.verifications);
      verifications.set(id, updated);
      return { ...next, verifications, current_verification_id: null };
    }
    case "verification_rerun": {
      const parent = getString(payload, "parent_verification_id");
      // Re-open the parent as the current verification, copying its
      // command/type/linked_hypothesis_id, resetting terminal state.
      if (parent === null) return next;
      const cur = state.verifications.get(parent);
      if (!cur) return next;
      const updated: import("./state.js").VerificationState = {
        ...cur,
        id: event.id,
        state: "started",
        stderr_excerpt: null,
        error: null,
        parent_verification_id: parent,
        started_at: event.created_at,
        ended_at: null,
        // Rerun starts a fresh attempt — clear all outcome fields
        // (the new run will repopulate them on pass/fail).
        duration_ms: null,
        exit_code: null,
        stdout_excerpt: null,
        created_artifact_id: null,
        last_event_id: event.id,
      };
      const verifications = new Map(state.verifications);
      verifications.set(event.id, updated);
      return {
        ...next,
        verifications,
        current_verification_id: event.id,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
    }

    case "artifact_attached": {
      const path = getString(payload, "artifact_id") ?? "";
      const kind = getString(payload, "role") ?? "evidence";
      const role: ArtifactRole = isArtifactRole(kind) ? kind : "evidence";
      const a: import("./state.js").ArtifactState = {
        id: event.id,
        path,
        kind,
        role,
        sha256: null,
        size_bytes: null,
        archived: false,
        created_at: event.created_at,
        last_event_id: event.id,
      };
      const artifacts = new Map(state.artifacts);
      artifacts.set(event.id, a);
      return { ...next, artifacts };
    }

    case "edge_created": {
      const edge_type = getString(payload, "edge_type") ?? "";
      const from_entity_type = getString(payload, "from_entity_type") ?? "";
      const from_entity_id = getString(payload, "from_entity_id") ?? "";
      const to_entity_type = getString(payload, "to_entity_type") ?? "";
      const to_entity_id = getString(payload, "to_entity_id") ?? "";
      const e: EdgeState = {
        id: event.id,
        edge_type,
        from_entity_type,
        from_entity_id,
        to_entity_type,
        to_entity_id,
        created_at: event.created_at,
      };
      const newEdges: ReadonlyArray<EdgeState> = [...state.edges, e];
      const nextHypotheses = new Map(state.hypotheses);
      const nextTheories = new Map(state.theories);
      if (edge_type === "belongs_to" && from_entity_type === "hypothesis") {
        const h = state.hypotheses.get(from_entity_id);
        if (h) {
          nextHypotheses.set(from_entity_id, {
            ...h,
            belongs_to_theory_id: to_entity_id,
            last_event_id: event.id,
            last_event_at: event.created_at,
          });
        }
      }
      if (
        edge_type === "belongs_to" &&
        to_entity_type === "theory" &&
        from_entity_type === "hypothesis"
      ) {
        const t = state.theories.get(to_entity_id);
        if (t) {
          const existing = t.hypothesis_ids;
          if (!existing.includes(from_entity_id)) {
            nextTheories.set(to_entity_id, {
              ...t,
              hypothesis_ids: [...existing, from_entity_id],
              last_event_id: event.id,
              last_event_at: event.created_at,
            });
          }
        }
      }
      return {
        ...next,
        edges: newEdges,
        hypotheses: nextHypotheses,
        theories: nextTheories,
        last_event_id: event.id,
        last_event_at: event.created_at,
      };
    }

    default: {
      // Unknown event type that we don't recognize at all. Append to
      // timeline only; do not crash.
      return next;
    }
  }
};

/**
 * Reduce a list of events to a SessionState. The result is the state
 * AFTER the last event was applied.
 *
 * If `initial` is provided, it represents the state as captured at
 * `initial.snapshot_event_id`. We then apply only events whose `id`
 * sorts strictly after that event id. This is the snapshot+tail path.
 */
export const reduce = (
  events: ReadonlyArray<ReducerEvent>,
  initial?: SessionState,
): SessionState => {
  const ordered = sortEvents(events);
  let startIndex = 0;
  if (initial && initial.snapshot_event_id !== null) {
    const snapshotId = initial.snapshot_event_id;
    for (let i = 0; i < ordered.length; i++) {
      const e = ordered[i];
      if (e && e.id === snapshotId) {
        startIndex = i + 1;
        break;
      }
    }
  }
  let state: SessionState =
    initial ??
    emptySessionState({
      session_id: "",
      project_id: "",
      goal: "",
    });
  for (let i = startIndex; i < ordered.length; i++) {
    const e = ordered[i];
    if (!e) continue;
    state = applyEvent(state, e);
  }
  return state;
};

/** Exposed for tests. */
export const _internal = {
  STATE_EVENT_TYPES,
  NON_STATE_EVENT_TYPES,
  ALL_KNOWN_TYPES,
  isVerificationLifecycle,
  isSessionLifecycle,
  isConclusionLifecycle,
  isHypothesisLifecycle,
};
