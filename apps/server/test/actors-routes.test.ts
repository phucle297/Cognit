/**
 * apps/server/test/actors-routes.test.ts — 4 cases covering phase 5.6.
 *
 *   1. GET /actors lists (auto-registered actors from POST /events
 *      appear; the bootstrap POST /events already inserts an actor
 *      for "alice:human").
 *   2. POST /actors with a valid body returns 201 and emits an
 *      `actor_registered` event when `session_id` is supplied.
 *   3. POST /actors with an invalid type returns 400.
 *   4. POST /actors with a duplicate name returns 409.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";

describe("cognit server — /actors routes (phase 5.6)", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("1. GET /actors lists at least one auto-registered actor", async () => {
    const f = fetchApp(ctx.app);
    // The bootstrap POST /events uses "alice:human" → alice is
    // auto-registered by ensureActor with default trust_score 0.9.
    const r = await f("/actors");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      kind: string;
      data: { actors: ReadonlyArray<{ name: string; type: string; trust_score: number }> };
    };
    expect(body.kind).toBe("actors.list");
    const alice = body.data.actors.find((a) => a.name === "alice");
    expect(alice).toBeDefined();
    expect(alice!.type).toBe("human");
    expect(alice!.trust_score).toBeGreaterThan(0);
  });

  it("2. POST /actors with a valid body returns 201 + emits actor_registered", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/actors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "bob",
        type: "worker",
        trust_score: 0.42,
        session_id: ctx.sessionId,
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      kind: string;
      data: { actor: { id: string; name: string; type: string; trust_score: number }; event_id: string | null };
    };
    expect(body.kind).toBe("actor.registered");
    expect(body.data.actor.name).toBe("bob");
    expect(body.data.actor.type).toBe("worker");
    expect(body.data.actor.trust_score).toBe(0.42);
    expect(body.data.event_id).not.toBeNull();

    // The actor_registered event should be visible in the session log.
    const events = await f(`/sessions/${ctx.sessionId}/events?limit=200`);
    const eventsBody = (await events.json()) as {
      data: { events: ReadonlyArray<{ id: string; type: string }> };
    };
    const found = eventsBody.data.events.find(
      (e) => e.id === body.data.event_id && e.type === "actor_registered",
    );
    expect(found).toBeDefined();
  });

  it("3. POST /actors with an invalid type returns 400", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/actors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "rogue",
        type: "robot",
      }),
    });
    expect(r.status).toBe(400);
  });

  it("4. POST /actors with a duplicate name returns 409", async () => {
    const f = fetchApp(ctx.app);
    // First call inserts.
    const first = await f("/actors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "carol",
        type: "human",
      }),
    });
    expect(first.status).toBe(201);

    // Second call duplicates.
    const dup = await f("/actors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "carol",
        type: "human",
      }),
    });
    expect(dup.status).toBe(409);
    const dupBody = (await dup.json()) as { kind: string; code: string };
    expect(dupBody.kind).toBe("api_error");
    expect(dupBody.code).toBe("conflict");
  });
});