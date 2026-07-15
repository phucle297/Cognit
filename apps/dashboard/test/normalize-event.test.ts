import { describe, expect, it } from "vitest";
import { normalizeEvent, normalizeEvents } from "@/lib/normalize-event";

describe("normalizeEvent", () => {
  it("maps DB wire row to UI shape", () => {
    const n = normalizeEvent({
      id: "01EV0000000000000000000001",
      type: "observation_recorded",
      session_id: "01SESS0000000000000000001",
      actor_id: "01ACTOR000000000000000001",
      created_at: "2026-07-15T12:00:00.000Z",
      payload_json: JSON.stringify({
        text: "tool Bash returned",
        tool: "Bash",
        actor_name: "should-not-override-if-top-level",
      }),
    });
    expect(n).not.toBeNull();
    expect(n!.kind).toBe("observation_recorded");
    expect(n!.ts).toBe("2026-07-15T12:00:00.000Z");
    expect((n!.payload as { tool: string }).tool).toBe("Bash");
  });

  it("uses actor_name from payload when actor field missing", () => {
    const n = normalizeEvent({
      id: "01EV0000000000000000000002",
      type: "actor_registered",
      session_id: "01SESS0000000000000000001",
      created_at: "2026-07-15T12:00:00.000Z",
      payload_json: JSON.stringify({ actor_name: "claude-code", actor_type: "worker" }),
    });
    expect(n!.actor).toBe("claude-code");
  });

  it("passes through already-normalized rows", () => {
    const n = normalizeEvent({
      id: "01EV0000000000000000000003",
      kind: "decision",
      session_id: "01S",
      actor: "alice",
      ts: "2026-01-01T00:00:00.000Z",
      payload: { x: 1 },
    });
    expect(n).toEqual({
      id: "01EV0000000000000000000003",
      kind: "decision",
      session_id: "01S",
      actor: "alice",
      ts: "2026-01-01T00:00:00.000Z",
      payload: { x: 1 },
    });
  });

  it("normalizeEvents filters junk", () => {
    expect(normalizeEvents([null, { noid: true }, { id: "01A", type: "x", created_at: "t" }]).length).toBe(1);
  });
});
