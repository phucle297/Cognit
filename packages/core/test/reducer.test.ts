import { describe, expect, it } from "vitest";
import { applyEvent, reduce, sortEvents, _internal } from "../src/reducer.js";
import { emptySessionState, type ReducerEvent, type SessionState } from "../src/state.js";

/**
 * Test helpers — small, focused, no magic.
 *
 * `mkEvent` produces a valid ReducerEvent. Each call advances `now` by
 * 1ms so a batch of events has a stable chronological order without
 * the tests caring about the absolute timestamp.
 */

let nowCounter = 0;
const mkEvent = (overrides: Partial<ReducerEvent> & Pick<ReducerEvent, "id" | "type">): ReducerEvent => {
  nowCounter += 1;
  const created_at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, nowCounter)).toISOString();
  return {
    project_id: "01projectxxxxxxxxxxxxxxxxx",
    session_id: "01sessionxxxxxxxxxxxxxxxxx",
    actor_id: "01actor00000000000000000000a",
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

const baseState = (): SessionState =>
  emptySessionState({
    session_id: "01sessionxxxxxxxxxxxxxxxxx",
    project_id: "01projectxxxxxxxxxxxxxxxxx",
    goal: "investigate",
  });

describe("reducer — sortEvents", () => {
  it("sorts by (created_at, id) ascending", () => {
    resetClock();
    const a = mkEvent({ id: "01aaa" });
    const b = mkEvent({ id: "01bbb" });
    const c = mkEvent({ id: "01ccc" });
    const sorted = sortEvents([c, a, b]);
    expect(sorted.map((e) => e.id)).toEqual(["01aaa", "01bbb", "01ccc"]);
  });

  it("uses id as a stable tiebreaker when created_at collides", () => {
    resetClock();
    const e1: ReducerEvent = { ...mkEvent({ id: "01zzz" }), created_at: "2026-01-01T00:00:00.000Z" };
    const e2: ReducerEvent = { ...mkEvent({ id: "01aaa" }), created_at: "2026-01-01T00:00:00.000Z" };
    const sorted = sortEvents([e1, e2]);
    expect(sorted.map((e) => e.id)).toEqual(["01aaa", "01zzz"]);
  });
});

describe("reducer — non-state events are no-ops on entity state", () => {
  it("appends project_created, actor_registered, redaction_applied, constraint_rule_*, snapshot_created to the timeline only", () => {
    resetClock();
    const events: ReducerEvent[] = [
      mkEvent({ id: "01proj", type: "project_created", payload_json: '{"name":"p"}' }),
      mkEvent({ id: "01act", type: "actor_registered", payload_json: '{"actor_type":"human","actor_name":"alice","trust_score":0.9}' }),
      mkEvent({ id: "01red", type: "redaction_applied", payload_json: '{"pattern":"jwt","entity_type":"observation_recorded","entity_id":"x","field_path":"payload.value.text"}' }),
      mkEvent({ id: "01cra", type: "constraint_rule_added", payload_json: '{"rule_id":"r1","condition_json":"{}","actions_json":"[]"}' }),
      mkEvent({ id: "01cap", type: "constraint_rule_applied", payload_json: '{"rule_id":"r1","affected_hypothesis_ids":[]}' }),
      mkEvent({ id: "01snap", type: "snapshot_created", payload_json: '{"event_count_up_to":1,"state_json":"{}"}' }),
    ];
    const state = reduce(events, baseState());
    expect(state.timeline).toHaveLength(6);
    expect(state.observations).toHaveLength(0);
    expect(state.findings).toHaveLength(0);
    expect(state.hypotheses.size).toBe(0);
    expect(state.theories.size).toBe(0);
    expect(state.decisions.size).toBe(0);
    expect(state.conclusions.size).toBe(0);
    expect(state.verifications.size).toBe(0);
    expect(state.experiments.size).toBe(0);
    expect(state.artifacts.size).toBe(0);
    expect(state.edges).toHaveLength(0);
    expect(state.last_event_id).toBe("01snap");
  });
});

describe("reducer — session lifecycle", () => {
  it("session_created sets goal + parent_session_id + status=active", () => {
    resetClock();
    const state = applyEvent(
      baseState(),
      mkEvent({
        id: "01sess",
        type: "session_created",
        payload_json: JSON.stringify({ goal: "find the bug", parent_session_id: "01parent" }),
      }),
    );
    expect(state.goal).toBe("find the bug");
    expect(state.parent_session_id).toBe("01parent");
    expect(state.status).toBe("active");
  });

  it("session_paused -> paused, session_closed -> closed", () => {
    resetClock();
    let s = baseState();
    s = applyEvent(s, mkEvent({ id: "01p", type: "session_paused" }));
    expect(s.status).toBe("paused");
    s = applyEvent(s, mkEvent({ id: "01c", type: "session_closed" }));
    expect(s.status).toBe("closed");
  });
});

describe("reducer — observations and findings", () => {
  it("observation_recorded appends to observations[]", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({
          id: "01o1",
          type: "observation_recorded",
          payload_json: '{"text":"the moon is made of cheese"}',
        }),
        mkEvent({
          id: "01o2",
          type: "observation_recorded",
          payload_json: '{"text":"second observation"}',
        }),
      ],
      baseState(),
    );
    expect(s.observations).toHaveLength(2);
    expect(s.observations[0]?.text).toBe("the moon is made of cheese");
    expect(s.observations[1]?.id).toBe("01o2");
  });

  it("finding_created captures related_observation_ids", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({
          id: "01f",
          type: "finding_created",
          payload_json: JSON.stringify({
            text: "memory grows after HMR",
            related_observation_ids: ["01o1", "01o2"],
          }),
        }),
      ],
      baseState(),
    );
    expect(s.findings).toHaveLength(1);
    expect(s.findings[0]?.related_observation_ids).toEqual(["01o1", "01o2"]);
  });
});

describe("reducer — hypothesis state machine", () => {
  it("hypothesis_created -> active; current_hypothesis_id set", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({
          id: "01h",
          type: "hypothesis_created",
          payload_json: '{"title":"Turbopack leaks","text":"explain"}',
          confidence: 0.5,
        }),
      ],
      baseState(),
    );
    expect(s.current_hypothesis_id).toBe("01h");
    const h = s.hypotheses.get("01h");
    expect(h?.current_state).toBe("active");
    expect(h?.current_confidence).toBe(0.5);
  });

  it("hypothesis_weakened transitions active -> weakened and records reason", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({
          id: "01h",
          type: "hypothesis_created",
          payload_json: '{"title":"X","text":"x"}',
        }),
        mkEvent({
          id: "01w",
          type: "hypothesis_weakened",
          payload_json: '{"reason":"still possible but rare"}',
        }),
      ],
      baseState(),
    );
    const h = s.hypotheses.get("01h");
    expect(h?.current_state).toBe("weakened");
    expect(h?.current_reason).toBe("still possible but rare");
  });

  it("hypothesis_rejected(evidence) sets state, reason_type, current_confidence", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01h", type: "hypothesis_created", payload_json: '{"title":"X","text":"x"}' }),
        mkEvent({
          id: "01r",
          type: "hypothesis_rejected",
          payload_json: '{"reason_type":"evidence","superseded_by_id":null}',
          confidence: 0.1,
        }),
      ],
      baseState(),
    );
    const h = s.hypotheses.get("01h");
    expect(h?.current_state).toBe("rejected");
    expect(h?.reason_type).toBe("evidence");
    expect(h?.current_confidence).toBe(0.1);
  });

  it("hypothesis_rejected(superseded, by-id) records superseded_by_id", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01h", type: "hypothesis_created", payload_json: '{"title":"X","text":"x"}' }),
        mkEvent({
          id: "01r",
          type: "hypothesis_rejected",
          payload_json: '{"reason_type":"superseded","superseded_by_id":"01h2"}',
        }),
      ],
      baseState(),
    );
    const h = s.hypotheses.get("01h");
    expect(h?.reason_type).toBe("superseded");
    expect(h?.superseded_by_id).toBe("01h2");
  });

  it("hypothesis_promoted sets promoted_to_theory_id", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01h", type: "hypothesis_created", payload_json: '{"title":"X","text":"x"}' }),
        mkEvent({
          id: "01p",
          type: "hypothesis_promoted",
          payload_json: '{"promoted_to_theory_id":"01t"}',
        }),
      ],
      baseState(),
    );
    expect(s.hypotheses.get("01h")?.current_state).toBe("promoted");
    expect(s.hypotheses.get("01h")?.promoted_to_theory_id).toBe("01t");
  });

  it("transitions on a terminal hypothesis are no-ops", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01h", type: "hypothesis_created", payload_json: '{"title":"X","text":"x"}' }),
        mkEvent({
          id: "01r",
          type: "hypothesis_rejected",
          payload_json: '{"reason_type":"evidence","superseded_by_id":null}',
        }),
        // Try to weaken a rejected hypothesis -- should be a no-op.
        mkEvent({ id: "01w", type: "hypothesis_weakened", payload_json: '{"reason":"oops"}' }),
      ],
      baseState(),
    );
    expect(s.hypotheses.get("01h")?.current_state).toBe("rejected");
    expect(s.hypotheses.get("01h")?.current_reason).toBe("evidence");
  });

  it("weaken before any hypothesis_created is a no-op (no crash)", () => {
    resetClock();
    const s = reduce(
      [mkEvent({ id: "01w", type: "hypothesis_weakened", payload_json: '{"reason":"x"}' })],
      baseState(),
    );
    expect(s.hypotheses.size).toBe(0);
    expect(s.current_hypothesis_id).toBeNull();
  });

  it("advances current_hypothesis_id on a new hypothesis_created", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01h1", type: "hypothesis_created", payload_json: '{"title":"A","text":"a"}' }),
        mkEvent({ id: "01h2", type: "hypothesis_created", payload_json: '{"title":"B","text":"b"}' }),
      ],
      baseState(),
    );
    expect(s.current_hypothesis_id).toBe("01h2");
    expect(s.hypotheses.size).toBe(2);
  });
});

describe("reducer — theory state machine", () => {
  it("theory_created adds entity; theory_updated mutates text", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({
          id: "01t",
          type: "theory_created",
          payload_json: '{"title":"HMR retention","text":"initial"}',
        }),
        mkEvent({
          id: "01u",
          type: "theory_updated",
          payload_json: '{"text":"updated body"}',
        }),
      ],
      baseState(),
    );
    expect(s.theories.get("01t")?.text).toBe("updated body");
  });

  it("theory_merged sets merged_into_theory_id on the current theory; theory_archived flips archived on the current theory", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01t1", type: "theory_created", payload_json: '{"title":"A","text":"a"}' }),
        mkEvent({ id: "01t2", type: "theory_created", payload_json: '{"title":"B","text":"b"}' }),
        // merged applies to current_theory_id = 01t2
        mkEvent({ id: "01m", type: "theory_merged", payload_json: '{"merged_into_theory_id":"01t1"}' }),
        // archived still applies to 01t2 (merged does not advance the pointer)
        mkEvent({ id: "01a", type: "theory_archived" }),
      ],
      baseState(),
    );
    expect(s.theories.get("01t2")?.merged_into_theory_id).toBe("01t1");
    expect(s.theories.get("01t2")?.archived).toBe(true);
    expect(s.theories.get("01t1")?.merged_into_theory_id).toBeNull();
  });
});

describe("reducer — experiment", () => {
  it("experiment_created + experiment_completed: supports/contradicts captured", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({
          id: "01x",
          type: "experiment_created",
          payload_json: '{"tests_hypothesis_id":"01h","design":"disable turbopack, measure memory"}',
        }),
        mkEvent({
          id: "01c",
          type: "experiment_completed",
          payload_json: JSON.stringify({
            result_summary: "no change",
            supports: ["01h1"],
            contradicts: ["01h2"],
          }),
        }),
      ],
      baseState(),
    );
    const e = s.experiments.get("01x");
    expect(e?.completed).toBe(true);
    expect(e?.result_summary).toBe("no change");
    expect(e?.supports).toEqual(["01h1"]);
    expect(e?.contradicts).toEqual(["01h2"]);
  });

  it("experiment_completed applies to the most recent uncompleted experiment", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({
          id: "01x1",
          type: "experiment_created",
          payload_json: '{"tests_hypothesis_id":"01h1","design":"d1"}',
        }),
        mkEvent({
          id: "01x2",
          type: "experiment_created",
          payload_json: '{"tests_hypothesis_id":"01h2","design":"d2"}',
        }),
        mkEvent({
          id: "01c",
          type: "experiment_completed",
          payload_json: '{"result_summary":"second finished"}',
        }),
      ],
      baseState(),
    );
    expect(s.experiments.get("01x1")?.completed).toBe(false);
    expect(s.experiments.get("01x2")?.completed).toBe(true);
  });
});

describe("reducer — decision state machine", () => {
  it("proposed -> accepted captures based_on_conclusion_ids", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({
          id: "01d",
          type: "decision_proposed",
          payload_json: '{"text":"disable Turbopack in CI","based_on_conclusion_ids":["01c"]}',
        }),
        mkEvent({
          id: "01a",
          type: "decision_accepted",
          payload_json: '{"based_on_conclusion_ids":["01c","01c2"]}',
        }),
      ],
      baseState(),
    );
    const d = s.decisions.get("01d");
    expect(d?.state).toBe("accepted");
    expect(d?.based_on_conclusion_ids).toEqual(["01c", "01c2"]);
  });

  it("rejected records reason; superseded records superseded_by_decision_id", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01d1", type: "decision_proposed", payload_json: '{"text":"x","based_on_conclusion_ids":[]}' }),
        mkEvent({ id: "01d2", type: "decision_proposed", payload_json: '{"text":"y","based_on_conclusion_ids":[]}' }),
        // rejected applies to current = 01d2; then a third proposed advances
        mkEvent({ id: "01r", type: "decision_rejected", payload_json: '{"reason":"too risky"}' }),
        mkEvent({ id: "01d3", type: "decision_proposed", payload_json: '{"text":"z","based_on_conclusion_ids":[]}' }),
        // superseded applies to current = 01d3
        mkEvent({ id: "01s", type: "decision_superseded", payload_json: '{"superseded_by_decision_id":"01d1"}' }),
      ],
      baseState(),
    );
    expect(s.decisions.get("01d2")?.state).toBe("rejected");
    expect(s.decisions.get("01d2")?.reason).toBe("too risky");
    expect(s.decisions.get("01d3")?.state).toBe("superseded");
    expect(s.decisions.get("01d3")?.superseded_by_decision_id).toBe("01d1");
    expect(s.decisions.get("01d1")?.state).toBe("proposed");
  });
});

describe("reducer — conclusion state machine", () => {
  it("proposed -> verified captures verification_id and supporting_evidence_ids", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({
          id: "01c",
          type: "conclusion_proposed",
          payload_json: '{"text":"Turbopack is not the cause"}',
        }),
        mkEvent({
          id: "01v",
          type: "conclusion_verified",
          payload_json: '{"verification_id":"01vr","supporting_evidence_ids":["01e1","01e2"]}',
        }),
      ],
      baseState(),
    );
    const c = s.conclusions.get("01c");
    expect(c?.state).toBe("verified");
    expect(c?.verification_id).toBe("01vr");
    expect(c?.supporting_evidence_ids).toEqual(["01e1", "01e2"]);
  });

  it("rejected records reason", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01c", type: "conclusion_proposed", payload_json: '{"text":"x"}' }),
        mkEvent({ id: "01r", type: "conclusion_rejected", payload_json: '{"reason":"insufficient evidence"}' }),
      ],
      baseState(),
    );
    expect(s.conclusions.get("01c")?.state).toBe("rejected");
    expect(s.conclusions.get("01c")?.reason).toBe("insufficient evidence");
  });
});

describe("reducer — verification state machine", () => {
  it("started -> passed flips state and sets ended_at; clears current", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({
          id: "01v",
          type: "verification_started",
          payload_json: '{"command":"npm test","type":"test","linked_hypothesis_id":null}',
        }),
        mkEvent({ id: "01p", type: "verification_passed" }),
      ],
      baseState(),
    );
    const v = s.verifications.get("01v");
    expect(v?.state).toBe("passed");
    expect(v?.ended_at).not.toBeNull();
    expect(s.current_verification_id).toBeNull();
  });

  it("started -> failed captures stderr_excerpt", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01v", type: "verification_started", payload_json: '{"command":"x","type":"test","linked_hypothesis_id":null}' }),
        mkEvent({ id: "01f", type: "verification_failed", payload_json: '{"stderr_excerpt":"TypeError: undefined"}' }),
      ],
      baseState(),
    );
    expect(s.verifications.get("01v")?.state).toBe("failed");
    expect(s.verifications.get("01v")?.stderr_excerpt).toBe("TypeError: undefined");
  });

  it("started -> errored captures error; -> cancelled captures reason", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01v", type: "verification_started", payload_json: '{"command":"x","type":"test","linked_hypothesis_id":null}' }),
        mkEvent({ id: "01e", type: "verification_errored", payload_json: '{"error":"ENOENT"}' }),
      ],
      baseState(),
    );
    expect(s.verifications.get("01v")?.state).toBe("errored");
    expect(s.verifications.get("01v")?.error).toBe("ENOENT");
  });

  it("verification_rerun copies parent and reopens as started", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01v", type: "verification_started", payload_json: '{"command":"npm test","type":"test","linked_hypothesis_id":null}' }),
        mkEvent({ id: "01f", type: "verification_failed", payload_json: '{"stderr_excerpt":"x"}' }),
        mkEvent({ id: "01r", type: "verification_rerun", payload_json: '{"parent_verification_id":"01v"}' }),
      ],
      baseState(),
    );
    expect(s.verifications.get("01r")?.state).toBe("started");
    expect(s.verifications.get("01r")?.parent_verification_id).toBe("01v");
    expect(s.verifications.get("01r")?.command).toBe("npm test");
    expect(s.current_verification_id).toBe("01r");
  });
});

describe("reducer — artifact_attached and edge_created", () => {
  it("artifact_attached captures path/kind/role", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({
          id: "01a",
          type: "artifact_attached",
          payload_json: '{"artifact_id":"01art","role":"log"}',
        }),
      ],
      baseState(),
    );
    const art = s.artifacts.get("01a");
    expect(art?.role).toBe("log");
    expect(art?.path).toBe("01art");
  });

  it("edge_created(belongs_to) links hypothesis to theory on both sides", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01h", type: "hypothesis_created", payload_json: '{"title":"X","text":"x"}' }),
        mkEvent({ id: "01t", type: "theory_created", payload_json: '{"title":"T","text":"t"}' }),
        mkEvent({
          id: "01e",
          type: "edge_created",
          payload_json: JSON.stringify({
            edge_type: "belongs_to",
            from_entity_type: "hypothesis",
            from_entity_id: "01h",
            to_entity_type: "theory",
            to_entity_id: "01t",
          }),
        }),
      ],
      baseState(),
    );
    expect(s.hypotheses.get("01h")?.belongs_to_theory_id).toBe("01t");
    expect(s.theories.get("01t")?.hypothesis_ids).toEqual(["01h"]);
    expect(s.edges).toHaveLength(1);
  });
});

describe("reducer — reduce (entry point)", () => {
  it("replays events into a complete SessionState", () => {
    resetClock();
    const s = reduce(
      [
        mkEvent({ id: "01obs", type: "observation_recorded", payload_json: '{"text":"x"}' }),
        mkEvent({ id: "01h", type: "hypothesis_created", payload_json: '{"title":"X","text":"x"}' }),
        mkEvent({ id: "01w", type: "hypothesis_weakened", payload_json: '{"reason":"r"}' }),
        mkEvent({ id: "01r", type: "hypothesis_rejected", payload_json: '{"reason_type":"evidence","superseded_by_id":null}' }),
      ],
      baseState(),
    );
    expect(s.timeline).toHaveLength(4);
    expect(s.hypotheses.get("01h")?.current_state).toBe("rejected");
    expect(s.observations).toHaveLength(1);
  });

  it("re-folding the same events is idempotent (deterministic output)", () => {
    resetClock();
    const events: ReducerEvent[] = [
      mkEvent({ id: "01h", type: "hypothesis_created", payload_json: '{"title":"X","text":"x"}', confidence: 0.5 }),
      mkEvent({ id: "01w", type: "hypothesis_weakened", payload_json: '{"reason":"r"}' }),
    ];
    const a = reduce(events, baseState());
    const b = reduce(events, baseState());
    expect(a.hypotheses.get("01h")).toEqual(b.hypotheses.get("01h"));
    expect(a.current_hypothesis_id).toBe(b.current_hypothesis_id);
  });

  it("snapshot+tail: restores state, then replays only events after snapshot_event_id", () => {
    resetClock();
    const allEvents: ReducerEvent[] = [
      mkEvent({ id: "01o1", type: "observation_recorded", payload_json: '{"text":"first"}' }),
      mkEvent({ id: "01o2", type: "observation_recorded", payload_json: '{"text":"second"}' }),
      mkEvent({ id: "01o3", type: "observation_recorded", payload_json: '{"text":"third"}' }),
      mkEvent({ id: "01o4", type: "observation_recorded", payload_json: '{"text":"fourth"}' }),
    ];
    // First reduce the first 3 events cold.
    const cold = reduce(allEvents.slice(0, 3), baseState());
    expect(cold.observations).toHaveLength(3);
    expect(cold.snapshot_event_id).toBeNull();
    // Take a snapshot at event "01o3".
    const snapshot: SessionState = { ...cold, snapshot_event_id: "01o3" };
    // Resume from snapshot + tail: should add only the 4th observation.
    const resumed = reduce(allEvents, snapshot);
    expect(resumed.observations).toHaveLength(4);
    expect(resumed.snapshot_event_id).toBe("01o3");
    expect(resumed.observations[3]?.text).toBe("fourth");
  });

  it("reduce over an empty event list returns initial state unchanged", () => {
    resetClock();
    const s = reduce([], baseState());
    expect(s.observations).toHaveLength(0);
    expect(s.hypotheses.size).toBe(0);
    expect(s.timeline).toHaveLength(0);
  });
});

describe("reducer — internal coverage of all event types", () => {
  it("STATE_EVENT_TYPES covers every state-changing event in plan.xml", () => {
    const expected = [
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
    ];
    for (const t of expected) {
      expect(_internal.STATE_EVENT_TYPES.has(t), `state event ${t}`).toBe(true);
    }
  });

  it("NON_STATE_EVENT_TYPES covers the audit/system events", () => {
    for (const t of [
      "project_created",
      "actor_registered",
      "redaction_applied",
      "constraint_rule_added",
      "constraint_rule_applied",
      "snapshot_created",
    ]) {
      expect(_internal.NON_STATE_EVENT_TYPES.has(t), `non-state event ${t}`).toBe(true);
    }
  });
});
