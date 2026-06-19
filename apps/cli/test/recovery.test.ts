/**
 * apps/cli/test/recovery.test.ts — unit tests for the recovery
 * command's print formatters. Pure-function tests so they run
 * without a server; the formatters are the only surface the CLI
 * adds on top of `serverFetch`. Integration tests would spin up
 * the Hono server, which is covered by the server-side tests.
 */
import { describe, expect, it } from "vitest";
import {
  formatRecoveryText,
  formatRecoveryBlock,
  RECOVERY_FIELD_NAMES,
} from "../src/commands/recovery.js";

// ULID-like ids are prefixed with 0, which trips oxc's number
// parser. Quote them everywhere as strings — they are ids, not
// numbers — so the fixture mirrors the real on-the-wire shape
// (every id the server emits is a JSON string).
const ID_SESSION = "01HZZZABCDEFGHJKMNPQRSTVW";
const ID_REL1 = "01HZZ1AAA00000000000000000";
const ID_REL2 = "01HZZ2BBB00000000000000000";
const ID_CONC = "01HZZC11100000000000000000";
const ID_VERIF = "01HZZV11100000000000000000";
const ID_HYP1 = "01HZZR11100000000000000000";
const ID_HYP2 = "01HZZR22200000000000000000";
const ID_DEC_OK = "01HZZD11100000000000000000";
const ID_DEC_REJ = "01HZZD22200000000000000000";
const ID_LV = "01HZVV11100000000000000000";

const sampleRecovery: Record<string, unknown> = {
  session_id: ID_SESSION,
  related_sessions: [
    { id: ID_REL1, score: 0.842, matched_on: "goal: investigate flakiness" },
    { id: ID_REL2, score: 0.611, matched_on: "finding: timing race" },
  ],
  verified_conclusions: [
    {
      id: ID_CONC,
      text: "Concurrency bug fixed by mutex",
      verification_id: ID_VERIF,
      supporting_evidence_ids: [ID_HYP1],
      created_at: "2026-04-01T12:00:00Z",
    },
  ],
  rejected_hypotheses: [
    {
      id: ID_HYP1,
      title: "DB lock",
      text: "DB lock is the cause",
      reason: "no lock contention",
      reason_type: "evidence",
    },
    {
      id: ID_HYP2,
      title: "GC pause",
      text: "GC pause triggers hang",
      reason: "no GC logs",
      reason_type: "evidence",
    },
  ],
  accepted_decisions: [
    {
      id: ID_DEC_OK,
      text: "Use single-writer queue",
      based_on: [ID_HYP1],
      created_at: "2026-04-02T00:00:00Z",
    },
  ],
  rejected_decisions: [
    {
      id: ID_DEC_REJ,
      text: "Switch to Redis",
      reason: "too disruptive",
      created_at: "2026-04-02T01:00:00Z",
    },
  ],
  latest_verification: {
    [ID_HYP1]: {
      id: ID_LV,
      hypothesis_id: ID_HYP1,
      type: "test",
      command: "pnpm test",
      state: "failed",
      started_at: "2026-04-01T11:00:00Z",
      ended_at: "2026-04-01T11:01:00Z",
    },
  },
  last_known_state: {
    session_id: ID_SESSION,
    goal: "Investigate flakiness in checkout",
    observations: [{ id: "1", created_at: "2026-04-01T10:00:00Z", text: "first" }],
    findings: [],
    hypotheses: { size: 2 },
    decisions: { size: 2 },
    conclusions: { size: 1 },
  },
  suggested_next_steps: [
    {
      id: "01HZZS11100000000000000000",
      text: "Retry verification on alpha hypothesis",
      score: 0.612,
    },
  ],
};

describe("recovery command formatters", () => {
  it("exposes all 8 v0.2 recovery fields", () => {
    expect(RECOVERY_FIELD_NAMES).toEqual([
      "related_sessions",
      "verified_conclusions",
      "rejected_hypotheses",
      "accepted_decisions",
      "rejected_decisions",
      "latest_verification",
      "last_known_state",
      "suggested_next_steps",
    ]);
  });

  it("formatRecoveryText emits all 8 field labels", () => {
    const text = formatRecoveryText(sampleRecovery);
    expect(text).toContain(`session: ${ID_SESSION}`);
    expect(text).toContain("related_sessions (2)");
    expect(text).toContain("verified_conclusions (1)");
    expect(text).toContain("rejected_hypotheses (2)");
    expect(text).toContain("accepted_decisions (1)");
    expect(text).toContain("rejected_decisions (1)");
    expect(text).toContain("latest_verification (1)");
    expect(text).toContain("last_known_state:");
    expect(text).toContain("suggested_next_steps (1)");
    // Phase 8 (8g.4): each step renders id + score + text.
    expect(text).toContain("01HZZS11100000000000000000");
    expect(text).toContain("score=0.612");
    expect(text).toContain("Retry verification on alpha hypothesis");
  });

  it("formatRecoveryText shows empty-state copy when no active hypotheses (8g.4)", () => {
    const text = formatRecoveryText({
      session_id: ID_SESSION,
      related_sessions: [],
      verified_conclusions: [],
      rejected_hypotheses: [],
      accepted_decisions: [],
      rejected_decisions: [],
      latest_verification: {},
      last_known_state: {
        session_id: ID_SESSION,
        goal: "",
        observations: [],
        findings: [],
        hypotheses: { size: 0 },
        decisions: { size: 0 },
        conclusions: { size: 0 },
      },
      suggested_next_steps: [],
    });
    expect(text).toContain("suggested_next_steps (0)");
    expect(text).toContain("(no active hypotheses to rank)");
  });

  it("formatRecoveryText handles empty arrays without crashing", () => {
    const text = formatRecoveryText({
      session_id: ID_SESSION,
      related_sessions: [],
      verified_conclusions: [],
      rejected_hypotheses: [],
      accepted_decisions: [],
      rejected_decisions: [],
      latest_verification: {},
      last_known_state: {
        session_id: ID_SESSION,
        goal: "",
        observations: [],
        findings: [],
        hypotheses: { size: 0 },
        decisions: { size: 0 },
        conclusions: { size: 0 },
      },
      suggested_next_steps: [],
    });
    expect(text).toContain("(0)");
    expect(text).toContain("(no goal)");
  });

  it("formatRecoveryBlock prints the 3-field minimum (AC-7.13)", () => {
    const block = formatRecoveryBlock(sampleRecovery);
    expect(block).toContain("=== Recovery Block ===");
    expect(block).toContain("rejected_hypotheses (2)");
    expect(block).toContain("verified_conclusions (1)");
    expect(block).toContain("accepted_decisions (1)");
    // First 3 entries are surfaced for each field.
    expect(block).toContain(ID_HYP1);
    expect(block).toContain(ID_HYP2);
    expect(block).toContain(ID_CONC);
    expect(block).toContain(ID_DEC_OK);
  });
});