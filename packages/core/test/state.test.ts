import { describe, expect, it } from "vitest";
import { applyEvent, sortEvents } from "../src/reducer.js";
import { emptySessionState, type ReducerEvent, type SessionState } from "../src/state.js";

/**
 * Pure-shape tests for the state helpers and the reducer's
 * non-state-event path. No I/O, no DB — these cover the contract
 * that the snapshot service and the snapshot+tail rebuild rely on.
 *
 * Conventions mirror `reducer.test.ts`: `mkEvent` produces a valid
 * ReducerEvent with a stable chronological `created_at`.
 */

let nowCounter = 0;
const mkEvent = (overrides: Partial<ReducerEvent> & Pick<ReducerEvent, "id">): ReducerEvent => {
  nowCounter += 1;
  const created_at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, nowCounter)).toISOString();
  return {
    project_id: "01projectxxxxxxxxxxxxxxxxx",
    session_id: "01sessionxxxxxxxxxxxxxxxxx",
    actor_id: "01actor00000000000000000000a",
    type: "observation_recorded",
    version: "1.0.0",
    payload_json: "{}",
    source_json: null,
    artifact_refs_json: null,
    causation_id: null,
    correlation_id: null,
    confidence: null,
    parent_verification_id: null,
    linked_hypothesis_id: null,
    created_at,
    ...overrides,
  };
};

const resetClock = (): void => {
  nowCounter = 0;
};

describe("state — emptySessionState", () => {
  it("returns a fully-empty state with the supplied identifiers", () => {
    const s = emptySessionState({
      session_id: "01s",
      project_id: "01p",
      goal: "investigate the bug",
    });
    expect(s.session_id).toBe("01s");
    expect(s.project_id).toBe("01p");
    expect(s.goal).toBe("investigate the bug");
    expect(s.parent_session_id).toBeNull();
    expect(s.status).toBe("active");
    // Entity maps and lists are empty.
    expect(s.observations).toEqual([]);
    expect(s.findings).toEqual([]);
    expect(s.hypotheses.size).toBe(0);
    expect(s.theories.size).toBe(0);
    expect(s.experiments.size).toBe(0);
    expect(s.decisions.size).toBe(0);
    expect(s.conclusions.size).toBe(0);
    expect(s.verifications.size).toBe(0);
    expect(s.artifacts.size).toBe(0);
    expect(s.edges).toEqual([]);
    expect(s.timeline).toEqual([]);
    // No current pointer; no snapshot.
    expect(s.current_hypothesis_id).toBeNull();
    expect(s.current_theory_id).toBeNull();
    expect(s.current_decision_id).toBeNull();
    expect(s.current_conclusion_id).toBeNull();
    expect(s.current_verification_id).toBeNull();
    expect(s.snapshot_event_id).toBeNull();
    expect(s.last_event_id).toBeNull();
    expect(s.last_event_at).toBeNull();
  });
});

describe("state — non-state events fold into timeline only", () => {
  it("project_created appends to timeline and advances last_event_id, no entity state", () => {
    resetClock();
    const start: SessionState = emptySessionState({
      session_id: "01s",
      project_id: "01p",
      goal: "g",
    });
    const next = applyEvent(
      start,
      mkEvent({ id: "01proj", type: "project_created", payload_json: '{"name":"p"}' }),
    );
    expect(next.timeline).toHaveLength(1);
    expect(next.timeline[0]?.id).toBe("01proj");
    expect(next.timeline[0]?.type).toBe("project_created");
    expect(next.last_event_id).toBe("01proj");
    expect(next.last_event_at).not.toBeNull();
    // No entity state changes.
    expect(next.hypotheses.size).toBe(0);
    expect(next.observations).toHaveLength(0);
    expect(next.findings).toHaveLength(0);
  });

  it("actor_registered appends to timeline and advances last_event_id", () => {
    resetClock();
    const start: SessionState = emptySessionState({
      session_id: "01s",
      project_id: "01p",
      goal: "g",
    });
    const next = applyEvent(
      start,
      mkEvent({
        id: "01act",
        type: "actor_registered",
        payload_json: '{"actor_type":"human","actor_name":"alice","trust_score":0.9}',
      }),
    );
    expect(next.timeline).toHaveLength(1);
    expect(next.timeline[0]?.type).toBe("actor_registered");
    expect(next.last_event_id).toBe("01act");
  });

  it("redaction_applied appends to timeline and advances last_event_id", () => {
    resetClock();
    const start: SessionState = emptySessionState({
      session_id: "01s",
      project_id: "01p",
      goal: "g",
    });
    const next = applyEvent(
      start,
      mkEvent({
        id: "01red",
        type: "redaction_applied",
        payload_json:
          '{"pattern":"jwt","entity_type":"observation_recorded","entity_id":"x","field_path":"payload.value.text"}',
      }),
    );
    expect(next.timeline).toHaveLength(1);
    expect(next.timeline[0]?.type).toBe("redaction_applied");
    expect(next.last_event_id).toBe("01red");
  });
});

describe("state — sortEvents ascending by (created_at, id)", () => {
  it("sorts unsorted input into replay order", () => {
    resetClock();
    const a = mkEvent({ id: "01aaa" });
    const b = mkEvent({ id: "01bbb" });
    const c = mkEvent({ id: "01ccc" });
    const sorted = sortEvents([c, a, b]);
    expect(sorted.map((e) => e.id)).toEqual(["01aaa", "01bbb", "01ccc"]);
  });

  it("breaks created_at ties by id ascending", () => {
    resetClock();
    const sameTime = "2026-01-01T00:00:00.000Z";
    const e1: ReducerEvent = { ...mkEvent({ id: "01zzz" }), created_at: sameTime };
    const e2: ReducerEvent = { ...mkEvent({ id: "01aaa" }), created_at: sameTime };
    const sorted = sortEvents([e1, e2]);
    expect(sorted.map((e) => e.id)).toEqual(["01aaa", "01zzz"]);
  });
});

describe("state — defensive JSON parse via applyEvent", () => {
  it("treats invalid payload_json on a state event as an empty object (no crash)", () => {
    // The reducer's internal `safeParse` returns null on bad JSON and
    // the apply switch uses `?? {}`, so a state event with malformed
    // payload must still produce a state update (defaults applied) and
    // must not throw.
    resetClock();
    const start: SessionState = emptySessionState({
      session_id: "01s",
      project_id: "01p",
      goal: "default-goal",
    });
    const next = applyEvent(
      start,
      mkEvent({
        id: "01bad",
        type: "session_created",
        // Not valid JSON. `safeParse` returns null → defaults applied.
        payload_json: "{not-json",
      }),
    );
    // The event is folded: status, last_event_id, etc. advance even
    // though the payload was unparseable.
    expect(next.status).toBe("active");
    expect(next.last_event_id).toBe("01bad");
    // Goal was not changed because the parse returned null and we
    // fell back to `state.goal` (the default in `emptySessionState`).
    expect(next.goal).toBe("default-goal");
    expect(next.timeline).toHaveLength(1);
  });

  it("parses a valid payload_json on a state event normally", () => {
    resetClock();
    const start: SessionState = emptySessionState({
      session_id: "01s",
      project_id: "01p",
      goal: "old-goal",
    });
    const next = applyEvent(
      start,
      mkEvent({
        id: "01good",
        type: "session_created",
        payload_json: JSON.stringify({ goal: "new-goal", parent_session_id: "01parent" }),
      }),
    );
    expect(next.goal).toBe("new-goal");
    expect(next.parent_session_id).toBe("01parent");
  });
});
