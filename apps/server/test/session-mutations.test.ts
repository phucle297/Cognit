/**
 * apps/server/test/session-mutations.test.ts — session lifecycle POST routes.
 *
 * 6 cases (plan §5.4.3):
 *   1. POST /sessions with goal → 201 + session row.
 *   2. POST /sessions/:id/pause on active → status=paused.
 *   3. POST /sessions/:id/close on paused → status=closed.
 *   4. POST /sessions/:id/resume (default fork) → new session with parent_session_id.
 *   5. POST /sessions/:id/pause on closed → 409 conflict.
 *   6. POST /sessions/:id/pause on unknown id → 404 not_found.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";

const actor = { name: "alice", type: "human" };

describe("cognit server — session mutations", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("POST /sessions creates a session and returns 201", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "investigate the dashboard", actor }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      kind: string;
      data: { session: { id: string; goal: string; status: string; project_id: string } };
    };
    expect(body.kind).toBe("session.created");
    expect(body.data.session.goal).toBe("investigate the dashboard");
    expect(body.data.session.status).toBe("active");
    expect(body.data.session.id).toMatch(/^[0-9A-Z]{20,30}$/);
    expect(body.data.session.project_id).toBe(ctx.projectId);
  });

  it("POST /sessions/:id/pause on an active session transitions to paused", async () => {
    const f = fetchApp(ctx.app);
    // Create via the bootstrap session id (active by default).
    const id = ctx.sessionId;
    const r = await f(`/api/sessions/${id}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      kind: string;
      data: { session: { status: string } };
    };
    expect(body.kind).toBe("session.paused");
    expect(body.data.session.status).toBe("paused");
  });

  it("POST /sessions/:id/close on a paused session transitions to closed", async () => {
    const f = fetchApp(ctx.app);
    const id = ctx.sessionId;
    // First pause, then close.
    const pause = await f(`/api/sessions/${id}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor }),
    });
    expect(pause.status).toBe(200);
    const close = await f(`/api/sessions/${id}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor }),
    });
    expect(close.status).toBe(200);
    const body = (await close.json()) as {
      kind: string;
      data: { session: { status: string; closed_at: string | null } };
    };
    expect(body.kind).toBe("session.closed");
    expect(body.data.session.status).toBe("closed");
    expect(body.data.session.closed_at).not.toBeNull();
  });

  it("POST /sessions/:id/resume (default fork) creates a new session with parent_session_id", async () => {
    const f = fetchApp(ctx.app);
    const parentId = ctx.sessionId;
    // Pause the parent first; resume of an active session is not
    // the common case and the service may return the same row.
    const pause = await f(`/api/sessions/${parentId}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor }),
    });
    expect(pause.status).toBe(200);

    const resume = await f(`/api/sessions/${parentId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor }), // fork_on_resume defaults to true
    });
    expect(resume.status).toBe(200);
    const body = (await resume.json()) as {
      kind: string;
      data: {
        session: { id: string; status: string; parent_session_id: string | null };
        parent: { id: string };
        forked: boolean;
      };
    };
    expect(body.kind).toBe("session.resumed");
    expect(body.data.forked).toBe(true);
    expect(body.data.parent.id).toBe(parentId);
    expect(body.data.session.parent_session_id).toBe(parentId);
    expect(body.data.session.id).not.toBe(parentId);
    expect(body.data.session.status).toBe("active");
  });

  it("POST /sessions/:id/pause on a closed session returns 409 conflict", async () => {
    const f = fetchApp(ctx.app);
    const id = ctx.sessionId;
    // Close first.
    const close = await f(`/api/sessions/${id}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor }),
    });
    expect(close.status).toBe(200);
    const pause = await f(`/api/sessions/${id}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor }),
    });
    expect(pause.status).toBe(409);
    const body = (await pause.json()) as { kind: string; code: string };
    expect(body.kind).toBe("api_error");
    expect(body.code).toBe("conflict");
  });

  it("POST /sessions/:id/pause on an unknown id returns 404 not_found", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/sessions/01nonexistentxxxxxxxxxx/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor }),
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { kind: string; code: string; details: { id: string } };
    expect(body.kind).toBe("api_error");
    expect(body.code).toBe("not_found");
    expect(body.details?.id).toBe("01nonexistentxxxxxxxxxx");
  });
});