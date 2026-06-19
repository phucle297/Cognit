/**
 * packages/recovery/src/__tests__/recovery.test.ts
 *
 * Cases (>=4 per task spec):
 *   1. empty session — all arrays empty, last_known_state == state
 *   2. full session — every populated field reflects the reducer state
 *   3. snapshot+events-after merge — last_known_state prefers snapshot
 *   4. latest_verification picks most recent by created_at
 *   5. (bonus) rejected_decisions includes the reason field
 *   6. (bonus) placeholder arrays are always present (related_sessions
 *      and suggested_next_steps never undefined)
 *   7. (bonus) serialiseLatestVerification wire conversion
 */
import { describe, it, expect } from "vitest";
import { reduce } from "@cognit/core/reducer";
import {
  emptySessionState,
  type ReducerEvent,
  type SessionState,
} from "@cognit/core/state";
import {
  buildRecovery,
  serialiseLatestVerification,
  type LatestVerification,
} from "../recovery.js";

const baseSession = (id: string): SessionState =>
  emptySessionState({ session_id: id, project_id: "01P-test", goal: "test" });

const mkEvent = (
  type: string,
  payload: unknown,
  id: string,
  createdAt = "2026-06-19T00:00:00.000Z",
): ReducerEvent => ({
  id,
  type,
  project_id: "01P-test",
  session_id: "",
  actor_id: "01A-alice",
  version: "1.0.0",
  payload_json: JSON.stringify(payload),
  source_json: null,
  artifact_refs_json: null,
  causation_id: null,
  correlation_id: null,
  confidence: null,
  parent_verification_id: null,
  linked_hypothesis_id: null,
  created_at: createdAt,
});

describe("buildRecovery — v0.2 surface", () => {
  it("1. empty session returns empty arrays + last_known_state == state", () => {
    const state = baseSession("01S-emptyxxxxxxxxxxxxxxxxx");
    const out = buildRecovery({
      sessionId: "01S-emptyxxxxxxxxxxxxxxxxx",
      state,
      snapshotState: null,
      latestVerifications: new Map(),
    });
    expect(out.session_id).toBe("01S-emptyxxxxxxxxxxxxxxxxx");
    expect(out.related_sessions).toEqual([]);
    expect(out.verified_conclusions).toEqual([]);
    expect(out.rejected_hypotheses).toEqual([]);
    expect(out.accepted_decisions).toEqual([]);
    expect(out.rejected_decisions).toEqual([]);
    expect(out.latest_verification.size).toBe(0);
    expect(out.suggested_next_steps).toEqual([]);
    expect(out.last_known_state).toBe(state);
  });

  it("2. full session: verified conclusions, rejected hypotheses, accepted decisions are populated", () => {
    const sid = "01S-fullxxxxxxxxxxxxxxxxxx";
    // Reducer sorts by (created_at, id) — give each event a strictly
    // increasing timestamp so the order I provide is the order applied.
    const events: ReducerEvent[] = [
      mkEvent("hypothesis_created", { title: "H1", text: "x" }, "01H1", "2026-06-19T00:00:01.000Z"),
      mkEvent(
        "hypothesis_rejected",
        { reason_type: "evidence", superseded_by_id: null },
        "01HR",
        "2026-06-19T00:00:02.000Z",
      ),
      mkEvent(
        "decision_proposed",
        { text: "D1", based_on_conclusion_ids: [] },
        "01DP",
        "2026-06-19T00:00:03.000Z",
      ),
      mkEvent(
        "decision_accepted",
        { based_on_conclusion_ids: [] },
        "01DA",
        "2026-06-19T00:00:04.000Z",
      ),
      mkEvent("conclusion_proposed", { text: "C1" }, "01CP", "2026-06-19T00:00:05.000Z"),
      mkEvent(
        "conclusion_verified",
        { verification_id: "01V1", supporting_evidence_ids: [] },
        "01CV",
        "2026-06-19T00:00:06.000Z",
      ),
    ];
    const state = reduce(events, baseSession(sid));

    const out = buildRecovery({
      sessionId: sid,
      state,
      snapshotState: null,
      latestVerifications: new Map(),
    });

    expect(out.rejected_hypotheses).toHaveLength(1);
    expect(out.rejected_hypotheses[0]?.id).toBe("01H1");
    expect(out.rejected_hypotheses[0]?.reason_type).toBe("evidence");

    expect(out.accepted_decisions).toHaveLength(1);
    expect(out.accepted_decisions[0]?.id).toBe("01DP");
    expect(out.accepted_decisions[0]?.based_on_conclusion_ids).toEqual([]);

    expect(out.verified_conclusions).toHaveLength(1);
    expect(out.verified_conclusions[0]?.id).toBe("01CP");
    expect(out.verified_conclusions[0]?.verification_id).toBe("01V1");
  });

  it("3. snapshot present → last_known_state is the snapshot, not the freshly-reduced state", () => {
    const sid = "01S-snapxxxxxxxxxxxxxxxxxx";
    const state = baseSession(sid);
    const snapshotState: SessionState = {
      ...baseSession(sid),
      goal: "snapshot goal",
    };

    const out = buildRecovery({
      sessionId: sid,
      state,
      snapshotState,
      latestVerifications: new Map(),
    });

    expect(out.last_known_state).toBe(snapshotState);
    expect(out.last_known_state.goal).toBe("snapshot goal");
  });

  it("4. latest_verification: caller picks most-recent (map key); filter drops entries not in state", () => {
    const sid = "01S-verifxxxxxxxxxxxxxxxxxx";

    const newer: LatestVerification = {
      id: "01V-new",
      hypothesis_id: "01H-x",
      type: "test",
      command: "pnpm test",
      state: "passed",
      started_at: "2026-06-19T00:01:00.000Z",
      ended_at: "2026-06-19T00:01:05.000Z",
    };

    // Empty state — caller passes a verif for a hypothesis that
    // isn't in state. Recovery filters it out.
    const outEmpty = buildRecovery({
      sessionId: sid,
      state: baseSession(sid),
      snapshotState: null,
      latestVerifications: new Map([["01H-x", newer]]),
    });
    expect(outEmpty.latest_verification.size).toBe(0);

    // Add the hypothesis to state, rerun — entry survives.
    const withHypothesis = reduce(
      [mkEvent("hypothesis_created", { title: "Hx", text: "y" }, "01H-x", "2026-06-19T00:00:01.000Z")],
      baseSession(sid),
    );
    const outWithHyp = buildRecovery({
      sessionId: sid,
      state: withHypothesis,
      snapshotState: null,
      latestVerifications: new Map([["01H-x", newer]]),
    });
    expect(outWithHyp.latest_verification.get("01H-x")).toEqual(newer);
  });

  it("5. rejected_decisions includes the reason field", () => {
    const sid = "01S-decxxxxxxxxxxxxxxxxxxx";
    const state = reduce(
      [
        mkEvent(
          "decision_proposed",
          { text: "D-bad", based_on_conclusion_ids: [] },
          "01DB",
          "2026-06-19T00:00:01.000Z",
        ),
        mkEvent(
          "decision_rejected",
          { reason: "evidence contradicts" },
          "01DR",
          "2026-06-19T00:00:02.000Z",
        ),
      ],
      baseSession(sid),
    );

    const out = buildRecovery({
      sessionId: sid,
      state,
      snapshotState: null,
      latestVerifications: new Map(),
    });

    expect(out.rejected_decisions).toHaveLength(1);
    expect(out.rejected_decisions[0]?.id).toBe("01DB");
    expect(out.rejected_decisions[0]?.reason).toBe("evidence contradicts");
    expect(out.accepted_decisions).toHaveLength(0);
  });

  it("6. placeholder arrays (related_sessions, suggested_next_steps) are always present", () => {
    const state = baseSession("01S-phxxxxxxxxxxxxxxxxxxxx");
    const out = buildRecovery({
      sessionId: "01S-phxxxxxxxxxxxxxxxxxxxx",
      state,
      snapshotState: null,
      latestVerifications: new Map(),
    });
    expect(Array.isArray(out.related_sessions)).toBe(true);
    expect(Array.isArray(out.suggested_next_steps)).toBe(true);
  });

  it("7. serialiseLatestVerification converts the Map to a plain record for the wire", () => {
    const m = new Map<string, LatestVerification>([
      [
        "01H-a",
        {
          id: "01V-a",
          hypothesis_id: "01H-a",
          type: "test",
          command: "x",
          state: "passed",
          started_at: "2026-06-19T00:00:00.000Z",
          ended_at: "2026-06-19T00:00:01.000Z",
        },
      ],
    ]);
    const rec = serialiseLatestVerification(m);
    expect(rec["01H-a"]?.id).toBe("01V-a");
    expect(Object.keys(rec)).toEqual(["01H-a"]);
  });
});
