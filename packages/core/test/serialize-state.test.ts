import { describe, expect, it } from "vitest";
import { emptySessionState } from "../src/state.js";
import {
  SNAPSHOT_SCHEMA_VERSION,
  entityStateForCompare,
  parseSnapshotStateJson,
  serializeSessionState,
  wrapSnapshotEnvelope,
} from "../src/serialize-state.js";

describe("serialize-state", () => {
  const base = emptySessionState({
    session_id: "01sessionxxxxxxxxxxxxxxxxx",
    project_id: "01projectxxxxxxxxxxxxxxxxx",
    goal: "g",
  });

  it("serializeSessionState converts Maps and sorts keys", () => {
    const state = {
      ...base,
      hypotheses: new Map([
        [
          "h1",
          {
            id: "h1",
            title: "t",
            text: "x",
            current_state: "active" as const,
            current_confidence: null,
            current_reason: null,
            reason_type: null,
            superseded_by_id: null,
            promoted_to_theory_id: null,
            belongs_to_theory_id: null,
            created_at: "2026-01-01T00:00:00.000Z",
            last_event_id: "e1",
            last_event_at: "2026-01-01T00:00:00.000Z",
            gravity_fired_at: 0,
            ai_rank_score: null,
            ai_rank_reasoning: null,
            ai_rank_evaluator: null,
            ai_rank_at: null,
            ai_rank_event_id: null,
          },
        ],
      ]),
    };
    const json = serializeSessionState(state);
    const parsed = JSON.parse(json) as { hypotheses: Record<string, unknown> };
    expect(parsed.hypotheses.h1).toBeDefined();
    expect((parsed.hypotheses.h1 as { id: string }).id).toBe("h1");
  });

  it("wrapSnapshotEnvelope writes schema_version 1 with slim timeline", () => {
    const envelope = JSON.parse(wrapSnapshotEnvelope(base, { slimTimeline: true })) as {
      schema_version: number;
      state: { timeline: unknown[] };
    };
    expect(envelope.schema_version).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(envelope.state.timeline).toEqual([]);
  });

  it("parseSnapshotStateJson accepts v1 envelope", () => {
    const raw = wrapSnapshotEnvelope(base, { slimTimeline: true });
    const parsed = parseSnapshotStateJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.schema_version).toBe(1);
    expect(parsed!.state["session_id"]).toBe(base.session_id);
  });

  it("parseSnapshotStateJson accepts legacy bare state as v0", () => {
    const bare = serializeSessionState(base);
    const parsed = parseSnapshotStateJson(bare);
    expect(parsed).not.toBeNull();
    expect(parsed!.schema_version).toBe(0);
    expect(parsed!.state["goal"]).toBe("g");
  });

  it("parseSnapshotStateJson rejects future schema versions", () => {
    const raw = JSON.stringify({ schema_version: 99, state: { session_id: "x" } });
    expect(parseSnapshotStateJson(raw)).toBeNull();
  });

  it("entityStateForCompare strips timeline", () => {
    const withTimeline = {
      ...base,
      timeline: [
        {
          id: "e1",
          project_id: base.project_id,
          session_id: base.session_id,
          actor_id: "a",
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
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const cmp = entityStateForCompare(withTimeline);
    expect(cmp).not.toHaveProperty("timeline");
    expect(cmp["last_event_id"]).toBeNull();
  });
});
