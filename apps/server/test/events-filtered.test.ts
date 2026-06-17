/**
 * apps/server/test/events-filtered.test.ts — 5 cases covering GET /events.
 *
 *   1. ?session=<id>&limit=N returns most recent N for the session.
 *   2. ?type=hypothesis_proposed filters to that type (repeated
 *      ?type=a&type=b expands).
 *   3. ?actor=<name> filters by actor name (joins to actors table).
 *   4. ?since=<ulid> excludes events with id <= since.
 *   5. Combined ?session=&type=&actor=&since=&limit= intersects all.
 *
 * The pagination cursor (`next_cursor`) is also asserted in #1 to
 * confirm ULID-cursor pagination surfaces when more rows exist
 * than the limit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";

/** Seed a fixed set of events so the filter cases have known inputs. */
const seed = async (ctx: TestApp): Promise<void> => {
  const f = fetchApp(ctx.app);
  const sid = ctx.sessionId;

  // hypothesis_created by alice
  const h = await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "hypothesis_created",
      payload: { title: "H1", text: "hypothesis body" },
      actor: "alice:human",
    }),
  });
  expect(h.status).toBe(201);

  // decision_proposed by bob (auto-registered via ensureActor)
  const d = await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "decision_proposed",
      payload: { text: "D1", based_on_conclusion_ids: [] },
      actor: "bob:worker",
    }),
  });
  expect(d.status).toBe(201);

  // observation_recorded by alice (third event)
  const o = await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "observation_recorded",
      payload: { text: "saw a thing" },
      actor: "alice:human",
    }),
  });
  expect(o.status).toBe(201);
};

describe("cognit server — GET /events filtered + paginated (phase 5.7)", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("1. ?session=<id>&limit=N returns most recent N for the session", async () => {
    await seed(ctx);
    const f = fetchApp(ctx.app);
    const r = await f(`/events?session=${ctx.sessionId}&limit=2`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      kind: string;
      data: { events: ReadonlyArray<{ id: string; type: string }>; next_cursor: string | null };
    };
    expect(body.kind).toBe("events.list");
    expect(body.data.events.length).toBe(2);
    // session_created (bootstrap) + 1 newer event = most recent 2.
    // The limit cuts to 2; we still expect next_cursor set because
    // there are 4 total events in the session.
    expect(body.data.next_cursor).not.toBeNull();
    expect(typeof body.data.next_cursor).toBe("string");
  });

  it("2. ?type=hypothesis_created filters to that type (repeated expands)", async () => {
    await seed(ctx);
    const f = fetchApp(ctx.app);
    const r = await f(`/events?type=hypothesis_created&type=decision_proposed`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      data: { events: ReadonlyArray<{ type: string }> };
    };
    const types = body.data.events.map((e) => e.type);
    // No observation_recorded events should appear.
    expect(types).not.toContain("observation_recorded");
    // hypothesis_created and decision_proposed are present (each once).
    expect(types.filter((t) => t === "hypothesis_created").length).toBe(1);
    expect(types.filter((t) => t === "decision_proposed").length).toBe(1);
  });

  it("3. ?actor=alice filters by actor name", async () => {
    await seed(ctx);
    const f = fetchApp(ctx.app);
    const r = await f(`/events?actor=alice&limit=200`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      data: { events: ReadonlyArray<{ type: string }> };
    };
    // Only events where actor = alice. alice emitted hypothesis_created
    // and observation_recorded (bob emitted decision_proposed).
    const types = body.data.events.map((e) => e.type);
    expect(types).toContain("hypothesis_created");
    expect(types).toContain("observation_recorded");
    expect(types).not.toContain("decision_proposed");
  });

  it("4. ?since=<ulid> excludes events with id <= since", async () => {
    await seed(ctx);
    const f = fetchApp(ctx.app);

    // Fetch all events, take the 2nd id as the `since` boundary.
    const all = await f(`/events?limit=200`);
    const allBody = (await all.json()) as {
      data: { events: ReadonlyArray<{ id: string }> };
    };
    const sinceId = allBody.data.events[1]!.id;

    const r = await f(`/events?since=${sinceId}&limit=200`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      data: { events: ReadonlyArray<{ id: string }> };
    };
    // Everything returned must be strictly > sinceId.
    for (const ev of body.data.events) {
      expect(ev.id > sinceId).toBe(true);
    }
    // The full set should be smaller than the unfiltered set.
    expect(body.data.events.length).toBeLessThan(allBody.data.events.length);
  });

  it("5. Combined ?session=&type=&actor=&since=&limit= intersects all clauses", async () => {
    await seed(ctx);
    const f = fetchApp(ctx.app);
    const all = await f(`/events?limit=200`);
    const allBody = (await all.json()) as {
      data: { events: ReadonlyArray<{ id: string }> };
    };
    // Pick an early id to use as `since` so all our seeded events
    // (created after bootstrap) qualify.
    const sinceId = allBody.data.events[0]!.id;

    const r = await f(
      `/events?session=${ctx.sessionId}&type=hypothesis_created&actor=alice&since=${sinceId}&limit=10`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      data: { events: ReadonlyArray<{ id: string; type: string }> };
    };
    expect(body.data.events.length).toBe(1);
    expect(body.data.events[0]!.type).toBe("hypothesis_created");
    expect(body.data.events[0]!.id > sinceId).toBe(true);
  });
});