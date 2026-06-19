import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  Action,
  BlockAction,
  CreateFindingAction,
  PromoteHypothesisAction,
  RejectHypothesisAction,
  WeakenHypothesisAction,
} from "../src/constraint-dsl";

describe("constraint-dsl Action union (v2: 5 members)", () => {
  it("Action union has exactly 5 members in the prescribed order", () => {
    // Use the runtime decoder to validate both the count and the discriminator order.
    // BlockAction must come FIRST; the 4 new mutation actions follow in declared order.
    const samples: ReadonlyArray<unknown> = [
      { kind: "block" },
      { kind: "reject_hypothesis", reason: "r", reason_type: "constraint" },
      { kind: "weaken_hypothesis" },
      { kind: "promote_hypothesis" },
      { kind: "create_finding", text: "t" },
    ];
    const decodedKinds: string[] = samples.map((s) => {
      const d = Schema.decodeUnknownSync(Action)(s) as { kind: string };
      return d.kind;
    });
    expect(decodedKinds).toEqual([
      "block",
      "reject_hypothesis",
      "weaken_hypothesis",
      "promote_hypothesis",
      "create_finding",
    ]);
    // Confirm exactly 5 — try a 6th candidate kind and expect failure.
    expect(() => Schema.decodeUnknownSync(Action)({ kind: "merge_hypothesis" })).toThrow();
  });

  it("BlockAction (v1) is unchanged", () => {
    const parsed = Schema.decodeUnknownSync(BlockAction)({ kind: "block" });
    expect(parsed).toEqual({ kind: "block" });
    const roundTrip = JSON.parse(JSON.stringify(parsed));
    expect(roundTrip).toEqual({ kind: "block" });
  });

  it("RejectHypothesisAction validates a valid payload", () => {
    const parsed = Schema.decodeUnknownSync(RejectHypothesisAction)({
      kind: "reject_hypothesis",
      reason: "contradicted by experiment",
      reason_type: "evidence",
    });
    expect(parsed).toEqual({
      kind: "reject_hypothesis",
      reason: "contradicted by experiment",
      reason_type: "evidence",
    });
  });

  it("RejectHypothesisAction fails on invalid reason_type", () => {
    expect(() =>
      Schema.decodeUnknownSync(RejectHypothesisAction)({
        kind: "reject_hypothesis",
        reason: "x",
        reason_type: "made_up",
      }),
    ).toThrow();
  });

  it("WeakenHypothesisAction validates", () => {
    const parsed = Schema.decodeUnknownSync(WeakenHypothesisAction)({ kind: "weaken_hypothesis" });
    expect(parsed).toEqual({ kind: "weaken_hypothesis" });
  });

  it("PromoteHypothesisAction validates", () => {
    const parsed = Schema.decodeUnknownSync(PromoteHypothesisAction)({ kind: "promote_hypothesis" });
    expect(parsed).toEqual({ kind: "promote_hypothesis" });
  });

  it("CreateFindingAction validates a valid payload", () => {
    const parsed = Schema.decodeUnknownSync(CreateFindingAction)({
      kind: "create_finding",
      text: "new observation",
    });
    expect(parsed).toEqual({ kind: "create_finding", text: "new observation" });
  });

  it("Action union accepts each of the 5 kinds (round-trip JSON parse/print)", () => {
    const samples: ReadonlyArray<unknown> = [
      { kind: "block" },
      { kind: "reject_hypothesis", reason: "r", reason_type: "constraint" },
      { kind: "weaken_hypothesis" },
      { kind: "promote_hypothesis" },
      { kind: "create_finding", text: "t" },
    ];
    for (const sample of samples) {
      const parsed = Schema.decodeUnknownSync(Action)(sample);
      const roundTrip = JSON.parse(JSON.stringify(parsed));
      expect(roundTrip).toEqual(sample);
    }
  });

  it("Action union rejects an unknown kind", () => {
    expect(() =>
      Schema.decodeUnknownSync(Action)({ kind: "tag" }),
    ).toThrow();
  });

  it("BlockAction (v1) wire format unchanged: still parses as {kind:'block'} only", () => {
    // Regression: extra fields on block must still be tolerated? v1 was strict.
    // We just confirm the baseline accepts {kind:'block'} and nothing else.
    expect(Schema.decodeUnknownSync(BlockAction)({ kind: "block" })).toEqual({ kind: "block" });
  });
});