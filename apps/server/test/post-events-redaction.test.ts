/**
 * apps/server/test/post-events-redaction.test.ts — redaction side-event.
 *
 * Posts an event whose payload contains a PEM block. The default
 * `BUILT_IN_REDACTION_PATTERNS.pem_block` matcher trips and the
 * event-store appends a `redaction_applied` event in the same
 * transaction (see `packages/db/src/event-store.ts`). The test
 * asserts BOTH events are visible via `GET /sessions/:id/events`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";

const PEM_BLOCK = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAuVfPiEjz9H5j8Q2k2nFv9oOq2oO9r5T5h7bZ4y2h7W3e1K
9oF0oF0oF0oF0oF0oF0oF0oF0oF0oF0oF0oF0oF0oF0oF0oF0oF0oF0oF0oF0
-----END RSA PRIVATE KEY-----`;

describe("cognit server — POST /events triggers redaction_applied", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("posts a PEM-block payload and emits a redaction_applied side-event", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: ctx.sessionId,
        type: "observation_recorded",
        payload: { text: `secrets below:\n${PEM_BLOCK}\n` },
        actor: "alice:human",
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      kind: string;
      data: { event: { type: string; payload_json: string } };
    };
    expect(body.kind).toBe("event.appended");
    expect(body.data.event.type).toBe("observation_recorded");
    // The payload in the response should be redacted (PEM block
    // replaced with [REDACTED:pem_block]).
    const payloadText = body.data.event.payload_json;
    expect(typeof payloadText).toBe("string");
    expect(payloadText).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(payloadText).toContain("[REDACTED:pem_block]");

    // Now GET /sessions/:id/events and assert BOTH events present.
    const er = await f(`/sessions/${ctx.sessionId}/events`);
    expect(er.status).toBe(200);
    const ebody = (await er.json()) as {
      kind: string;
      data: { events: ReadonlyArray<{ type: string; payload_json: string }> };
    };
    const types = ebody.data.events.map((e) => e.type);
    // Bootstrap emits session_created; the POST emits
    // observation_recorded; redaction emits redaction_applied.
    expect(types).toContain("observation_recorded");
    expect(types).toContain("redaction_applied");
    // The redaction_applied payload should reference pem_block and
    // a non-empty field path (proves the chokepoint attributed the
    // hit correctly).
    const redaction = ebody.data.events.find((e) => e.type === "redaction_applied");
    expect(redaction).toBeDefined();
    const redactionPayload = JSON.parse(redaction!.payload_json) as {
      pattern: string;
      field_path: string;
    };
    expect(redactionPayload.pattern).toBe("pem_block");
    expect(redactionPayload.field_path.length).toBeGreaterThan(0);
  });
});
