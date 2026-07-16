/**
 * Unit tests for D-M5-00 timeline format helpers.
 */
import { describe, expect, it } from "vitest";
import {
  eventFamilyLabel,
  formatActionKindLabel,
  formatPayloadSummary,
} from "@/shared/lib/format";

describe("eventFamilyLabel", () => {
  it("maps known semantic families", () => {
    expect(eventFamilyLabel("observation_recorded")).toBe("Observe");
    expect(eventFamilyLabel("action_recorded")).toBe("Action");
    expect(eventFamilyLabel("verification_failed")).toBe("Verify");
    expect(eventFamilyLabel("decision_proposed")).toBe("Decide");
    expect(eventFamilyLabel("conclusion_verified")).toBe("Conclude");
    expect(eventFamilyLabel("hypothesis_created")).toBe("Hypothesis");
    expect(eventFamilyLabel("session_created")).toBe("System");
  });

  it("Title-Cases unknown types", () => {
    expect(eventFamilyLabel("tool_call")).toBe("Tool Call");
    expect(eventFamilyLabel("raw_tool_signal")).toBe("Raw Tool Signal");
  });
});

describe("formatActionKindLabel", () => {
  it("sentence-cases snake_case kinds", () => {
    expect(formatActionKindLabel("applied_fix")).toBe("Applied fix");
    expect(formatActionKindLabel("dependency_change")).toBe("Dependency change");
    expect(formatActionKindLabel("generated")).toBe("Generated");
  });
});

describe("formatPayloadSummary", () => {
  it("prefers action_kind + text", () => {
    expect(
      formatPayloadSummary({
        action_kind: "applied_fix",
        text: "patched login race",
        evidence: { tool: "Edit" },
      }),
    ).toBe("Applied fix: patched login race");
  });

  it("prefers text field over other keys", () => {
    expect(formatPayloadSummary({ tool: "Bash", text: "ok" })).toBe("text: ok");
  });
});
