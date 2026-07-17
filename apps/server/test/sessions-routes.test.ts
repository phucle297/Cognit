/**
 * apps/server/test/sessions-routes.test.ts — `GET /sessions`,
 * `GET /sessions/:id`, `GET /sessions/:id/state`,
 * `GET /sessions/:id/events`, 404 on unknown id.
 *
 * 5 cases. The event store is empty for `unknown_id`; we only need
 * to assert the route shape + the 404 path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";

describe("cognit server — /sessions routes", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("GET /sessions returns the session list as a v1 envelope", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/sessions");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      version: number;
      kind: string;
      data: { sessions: ReadonlyArray<{ id: string }> };
    };
    expect(body.version).toBe(1);
    expect(body.kind).toBe("sessions.list");
    expect(body.data.sessions.length).toBe(1);
    expect(body.data.sessions[0]!.id).toBe(ctx.sessionId);
  });

  it("GET /sessions/:id returns the session row (session.get envelope)", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/${ctx.sessionId}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      kind: string;
      data: { session: { id: string }; matches: ReadonlyArray<{ id: string }> };
    };
    expect(body.kind).toBe("session.get");
    expect(body.data.session.id).toBe(ctx.sessionId);
    expect(body.data.matches.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /sessions/:id/state returns the full SessionState", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/${ctx.sessionId}/state`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      kind: string;
      data: {
        session: { id: string };
        state: {
          session_id: string;
          goal: string;
          decisions: unknown;
          hypotheses: unknown;
        };
      };
    };
    expect(body.kind).toBe("session.state");
    expect(body.data.session.id).toBe(ctx.sessionId);
    expect(body.data.state.session_id).toBe(ctx.sessionId);
    expect(body.data.state.goal).toBe("server test");
    // Map fields must be plain objects on the wire (JSON.stringify({})
    // would drop Map contents; sortKeysDeep materialises them).
    expect(body.data.state.decisions).not.toBeInstanceOf(Map);
    expect(typeof body.data.state.decisions).toBe("object");
    expect(body.data.state.decisions).not.toBeNull();
    expect(body.data.state.hypotheses).not.toBeInstanceOf(Map);
    expect(typeof body.data.state.hypotheses).toBe("object");
  });

  it("GET /sessions/:id/events returns the events for the session", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/${ctx.sessionId}/events?limit=10`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      kind: string;
      data: { events: ReadonlyArray<{ id: string; type: string }> };
    };
    expect(body.kind).toBe("events.list");
    expect(body.data.events.length).toBeGreaterThan(0);
    // Bootstrap creates session_created as the first event
    expect(body.data.events[0]!.type).toBe("session_created");
  });

  it("GET /sessions/:id/state on an unknown id returns 404", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/01nosuchsessxxxxxxxxxxx/state`);
    expect(r.status).toBe(404);
  });
});
