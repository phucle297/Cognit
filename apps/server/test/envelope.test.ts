/**
 * apps/server/test/envelope.test.ts — 3 cases covering the v1 envelope
 * contract after the phase 5.7 migration.
 *
 *   1. Success response carries `{ version: 1, kind, data }` — no
 *      `request_id` field on success bodies.
 *   2. 4xx response carries the api_error shape with `kind:"api_error"`,
 *      `code`, `message`, `request_id` (ULID-shaped).
 *   3. The error response does NOT leak the raw Effect `cause` field.
 *      Stack traces and SQLite internals stay server-side.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("cognit server — v1 envelope contract (phase 5.7)", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("1. Success response: { version: 1, kind, data }, no request_id", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/sessions");
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.version).toBe(1);
    expect(typeof body.kind).toBe("string");
    expect(body.data).toBeDefined();
    expect(body).not.toHaveProperty("request_id");
  });

  it("2. 4xx response: api_error shape with kind/code/message/request_id", async () => {
    const f = fetchApp(ctx.app);
    // POST /events with missing session_id triggers bad_request.
    const r = await f("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "x", payload: {}, actor: "a:b" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.kind).toBe("api_error");
    expect(body.code).toBe("bad_request");
    expect(typeof body.message).toBe("string");
    expect(typeof body.request_id).toBe("string");
    expect((body.request_id as string).match(ULID_RE)).not.toBeNull();
    // The response also carries the same id on the header so clients
    // can quote it in support tickets.
    expect(r.headers.get("x-request-id")).toBe(body.request_id);
  });

  it("3. Error response does not leak raw Effect cause or stack", async () => {
    const f = fetchApp(ctx.app);
    // POST /edges with unknown edge_type forces the server to surface
    // a validation_failed error. Internally this used to include a
    // raw `cause` field with the Effect Cause<string>; the v1 envelope
    // strips it.
    const r = await f(`/api/sessions/${ctx.sessionId}/edges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        edge_type: "nonsense",
        from: { entity_type: "finding", entity_id: "f1" },
        to: { entity_type: "hypothesis", entity_id: "h1" },
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("cause");
    // Defensive: no field of the body should look like a stack frame
    // (at-sign file paths, "at ", "Error:") etc.
    const flat = JSON.stringify(body);
    expect(flat).not.toMatch(/\bat \w+/);
    expect(flat).not.toMatch(/Error:/);
  });
});