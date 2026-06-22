/**
 * apps/server/test/sessions-gravity.test.ts — phase 8 (8g.4).
 *
 * Cases:
 *   1. GET /api/sessions/:id/gravity on empty session → ranked: []
 *   2. Adds 2 active hypotheses → ranked.length === 2, shape {id, text, score}
 *   3. Stable sort: score DESC then id ASC; rerun returns identical order
 *   4. 50 consecutive GET calls do not write any events (AC-8.13 read-only)
 *   5. Unknown session id → 404 not_found
 *   6. Rejected hypotheses are filtered out (only `active` rank)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchApp, makeApp, type TestApp } from "./helpers.js";

interface GravityResp {
  readonly kind: string;
  readonly data: {
    readonly ranked: ReadonlyArray<{
      readonly id: string;
      readonly text: string;
      readonly title: string;
      readonly score: number;
      readonly source: "ai" | "rule";
      readonly ai_score: number | null;
      readonly rule_score: number | null;
      readonly delta: number | null;
    }>;
  };
}

const post = async (
  ctx: TestApp,
  type: string,
  payload: Record<string, unknown>,
): Promise<string> => {
  const f = fetchApp(ctx.app);
  const r = await f("/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: ctx.sessionId,
      type,
      payload,
      actor: "alice:human",
    }),
  });
  expect(r.status).toBe(201);
  const body = (await r.json()) as { data: { event: { id: string } } };
  return body.data.event.id;
};

describe("GET /api/sessions/:id/gravity (phase 8 — 8g.4)", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("1. empty session returns ranked: []", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/${ctx.sessionId}/gravity`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as GravityResp;
    expect(body.kind).toBe("session.gravity");
    expect(body.data.ranked).toEqual([]);
  });

  it("2. two active hypotheses surface in ranked with {id, text, score}", async () => {
    await post(ctx, "hypothesis_created", { title: "HA", text: "alpha" });
    await post(ctx, "hypothesis_created", { title: "HB", text: "beta" });
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/${ctx.sessionId}/gravity`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as GravityResp;
    expect(body.data.ranked.length).toBe(2);
    for (const e of body.data.ranked) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.text).toBe("string");
      expect(typeof e.score).toBe("number");
      expect(e.score).toBeGreaterThanOrEqual(0);
      expect(e.score).toBeLessThanOrEqual(1);
    }
  });

  it("3. stable sort: score DESC then id ASC; deterministic across reruns", async () => {
    await post(ctx, "hypothesis_created", { title: "HA", text: "alpha" });
    await post(ctx, "hypothesis_created", { title: "HB", text: "beta" });
    await post(ctx, "hypothesis_created", { title: "HC", text: "gamma" });
    const f = fetchApp(ctx.app);
    const r1 = (await (await f(`/api/sessions/${ctx.sessionId}/gravity`)).json()) as GravityResp;
    const r2 = (await (await f(`/api/sessions/${ctx.sessionId}/gravity`)).json()) as GravityResp;
    // Same call → identical order.
    expect(r1.data.ranked.map((r) => r.id)).toEqual(r2.data.ranked.map((r) => r.id));
    // Sort invariant: score non-increasing; ties broken by id ASC.
    for (let i = 1; i < r1.data.ranked.length; i++) {
      const prev = r1.data.ranked[i - 1]!;
      const curr = r1.data.ranked[i]!;
      expect(prev.score).toBeGreaterThanOrEqual(curr.score);
      if (prev.score === curr.score) {
        expect(prev.id < curr.id).toBe(true);
      }
    }
  });

  it("4. 50 read calls leave the event log unchanged (AC-8.13 read-only)", async () => {
    await post(ctx, "hypothesis_created", { title: "H1", text: "x" });
    const f = fetchApp(ctx.app);
    const before = await f(`/api/sessions/${ctx.sessionId}/events?limit=500`);
    const beforeCount = ((await before.json()) as {
      data: { events: ReadonlyArray<unknown> };
    }).data.events.length;
    for (let i = 0; i < 50; i++) {
      const r = await f(`/api/sessions/${ctx.sessionId}/gravity`);
      expect(r.status).toBe(200);
    }
    const after = await f(`/api/sessions/${ctx.sessionId}/events?limit=500`);
    const afterCount = ((await after.json()) as {
      data: { events: ReadonlyArray<unknown> };
    }).data.events.length;
    expect(afterCount).toBe(beforeCount);
  });

  it("5. unknown session id returns 404 not_found", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/sessions/01nosuchsessxxxxxxxxxxx/gravity");
    expect(r.status).toBe(404);
    const body = (await r.json()) as { kind: string; code: string };
    expect(body.kind).toBe("api_error");
    expect(body.code).toBe("not_found");
  });

  it("6. rejected hypotheses are excluded from the ranking", async () => {
    await post(ctx, "hypothesis_created", { title: "H-rej", text: "to reject" });
    await post(ctx, "hypothesis_rejected", {
      reason_type: "evidence",
      superseded_by_id: null,
    });
    await post(ctx, "hypothesis_created", { title: "H-active", text: "active one" });
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/${ctx.sessionId}/gravity`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as GravityResp;
    expect(body.data.ranked.length).toBe(1);
    expect(body.data.ranked[0]!.text).toBe("active one");
  });
});
