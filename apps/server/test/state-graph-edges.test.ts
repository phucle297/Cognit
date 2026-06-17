/**
 * apps/server/test/state-graph-edges.test.ts — 8 cases covering phase 5.5.
 *
 *   1. GET /sessions/:id/state returns kind `session.state`.
 *   2. GET /sessions/:id/state on unknown id returns 404.
 *   3. GET /sessions/:id/graph returns nodes (deduped) + edges,
 *      including the virtual verified_by synthesized from a
 *      `conclusion_verified` event.
 *   4. GET /sessions/:id/recovery returns exactly the 3 v0.1 fields
 *      and NO related_sessions / suggested_next_steps.
 *   5. GET /sessions/:id/recovery on an empty session returns
 *      empty arrays for all three lists.
 *   6. GET /sessions/:id/edges returns typed edges (filterable).
 *   7. POST /sessions/:id/edges with a catalog edge_type emits
 *      an `edge_created` event visible in /sessions/:id/events.
 *   8. POST /sessions/:id/edges with an unknown edge_type returns
 *      400 with the `unknown_edge_type` error code.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";

interface SeedResult {
  readonly hypothesisId: string;
  readonly verificationId: string;
  readonly conclusionId: string;
}

/**
 * Seed one hypothesis → verification (started+passed) → conclusion →
 * conclusion_verified chain so we can test the verified_by synthesis.
 *
 * The reducer keys `hypothesis_created` / `decision_proposed` /
 * `conclusion_proposed` / `verification_started` onto the session's
 * `current_*_id`, so the subsequent lifecycle events resolve them
 * automatically — we don't have to thread ids in the payload.
 */
const seedVerifiedChain = async (
  ctx: TestApp,
): Promise<SeedResult> => {
  const f = fetchApp(ctx.app);
  const sid = ctx.sessionId;

  const r1 = await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "hypothesis_created",
      payload: { title: "H1", text: "hypothesis body" },
      actor: "alice:human",
    }),
  });
  expect(r1.status).toBe(201);
  const hypothesisId = ((await r1.json()) as {
    data: { event: { id: string } };
  }).data.event.id;

  const r2 = await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "verification_started",
      payload: {
        command: "true",
        type: "test",
        linked_hypothesis_id: hypothesisId,
      },
      actor: "alice:human",
    }),
  });
  expect(r2.status).toBe(201);
  const verificationId = ((await r2.json()) as {
    data: { event: { id: string } };
  }).data.event.id;

  await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "verification_passed",
      payload: {},
      actor: "alice:human",
    }),
  });

  const r3 = await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "conclusion_proposed",
      payload: { text: "C1" },
      actor: "alice:human",
    }),
  });
  expect(r3.status).toBe(201);
  const conclusionId = ((await r3.json()) as {
    data: { event: { id: string } };
  }).data.event.id;

  const r4 = await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "conclusion_verified",
      payload: {
        verification_id: verificationId,
        supporting_evidence_ids: [],
      },
      actor: "alice:human",
    }),
  });
  expect(r4.status).toBe(201);

  return { hypothesisId, verificationId, conclusionId };
};

/**
 * Seed a rejected hypothesis + an accepted decision. We emit them
 * before the corresponding `_created` events so the reducer's
 * `current_*_id` pointer resolves; we go (created → lifecycle) so
 * the lifecycle event attaches to the right entity.
 */
const seedRejectedAndAccepted = async (ctx: TestApp): Promise<void> => {
  const f = fetchApp(ctx.app);
  const sid = ctx.sessionId;

  const r1 = await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "hypothesis_created",
      payload: { title: "H-rej", text: "to be rejected" },
      actor: "alice:human",
    }),
  });
  expect(r1.status).toBe(201);

  await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "hypothesis_rejected",
      payload: { reason_type: "evidence", superseded_by_id: null },
      actor: "alice:human",
    }),
  });

  const r3 = await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "decision_proposed",
      payload: { text: "D1", based_on_conclusion_ids: [] },
      actor: "alice:human",
    }),
  });
  expect(r3.status).toBe(201);

  await f("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sid,
      type: "decision_accepted",
      payload: { based_on_conclusion_ids: [] },
      actor: "alice:human",
    }),
  });
};

describe("cognit server — state, graph, recovery, edges (phase 5.5)", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("1. GET /sessions/:id/state returns kind session.state", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/sessions/${ctx.sessionId}/state`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { kind: string; data: { session: { id: string } } };
    expect(body.kind).toBe("session.state");
    expect(body.data.session.id).toBe(ctx.sessionId);
  });

  it("2. GET /sessions/:id/state on an unknown id returns 404", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/sessions/01nosuchsessxxxxxxxxxxx/state");
    expect(r.status).toBe(404);
  });

  it("3. GET /sessions/:id/graph returns nodes + edges with synthesized verified_by", async () => {
    const { hypothesisId, verificationId, conclusionId } = await seedVerifiedChain(ctx);
    const f = fetchApp(ctx.app);
    const r = await f(`/sessions/${ctx.sessionId}/graph`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      kind: string;
      data: {
        session_id: string;
        nodes: ReadonlyArray<{ id: string; entity_type: string; entity_id: string; label: string }>;
        edges: ReadonlyArray<{
          id: string;
          edge_type: string;
          from: string;
          to: string;
          virtual: boolean;
        }>;
      };
    };
    expect(body.kind).toBe("session.graph");
    expect(body.data.session_id).toBe(ctx.sessionId);

    // Hypothesis, verification, and conclusion all materialized as nodes.
    const ids = new Set(body.data.nodes.map((n) => n.id));
    expect(ids.has(`hypothesis:${hypothesisId}`)).toBe(true);
    expect(ids.has(`verification:${verificationId}`)).toBe(true);
    expect(ids.has(`conclusion:${conclusionId}`)).toBe(true);

    // No duplicate node for the same entity_type:entity_id pair.
    const seen = new Set<string>();
    for (const n of body.data.nodes) {
      expect(seen.has(n.id)).toBe(false);
      seen.add(n.id);
    }

    // The synthesized virtual verified_by edge is present.
    const virtual = body.data.edges.find(
      (e) =>
        e.edge_type === "verified_by" &&
        e.from === `conclusion:${conclusionId}` &&
        e.to === `verification:${verificationId}`,
    );
    expect(virtual).toBeDefined();
    expect(virtual?.virtual).toBe(true);
  });

  it("4. GET /sessions/:id/recovery returns exactly 3 v0.1 fields, no v0.2 fields", async () => {
    await seedRejectedAndAccepted(ctx);
    const f = fetchApp(ctx.app);
    const r = await f(`/sessions/${ctx.sessionId}/recovery`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      kind: string;
      data: Record<string, unknown>;
    };
    expect(body.kind).toBe("session.recovery");
    // Exact key set — the v0.1 surface contract.
    expect(Object.keys(body.data).sort()).toEqual([
      "accepted_decisions",
      "rejected_hypotheses",
      "session_id",
      "verified_conclusions",
    ]);
    // v0.2 fields must NOT appear on this version.
    expect(body.data).not.toHaveProperty("related_sessions");
    expect(body.data).not.toHaveProperty("suggested_next_steps");

    const arr = (k: string): unknown[] =>
      (body.data[k] as ReadonlyArray<unknown>) as unknown[];
    expect(arr("rejected_hypotheses").length).toBe(1);
    expect(arr("accepted_decisions").length).toBe(1);
    expect(arr("verified_conclusions").length).toBe(0);
  });

  it("5. GET /sessions/:id/recovery on an empty session returns empty arrays", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/sessions/${ctx.sessionId}/recovery`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      kind: string;
      data: {
        rejected_hypotheses: unknown[];
        accepted_decisions: unknown[];
        verified_conclusions: unknown[];
      };
    };
    expect(body.data.rejected_hypotheses).toEqual([]);
    expect(body.data.accepted_decisions).toEqual([]);
    expect(body.data.verified_conclusions).toEqual([]);
  });

  it("6. GET /sessions/:id/edges returns typed edges and filters by edge_type", async () => {
    // Seed two edges via the chokepoint so we know what's in state.
    const f = fetchApp(ctx.app);
    const sid = ctx.sessionId;
    const r1 = await f(`/sessions/${sid}/edges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        edge_type: "supports",
        from: { entity_type: "finding", entity_id: "f1" },
        to: { entity_type: "hypothesis", entity_id: "h1" },
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r1.status).toBe(201);
    const r2 = await f(`/sessions/${sid}/edges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        edge_type: "contradicts",
        from: { entity_type: "finding", entity_id: "f2" },
        to: { entity_type: "hypothesis", entity_id: "h1" },
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r2.status).toBe(201);

    const all = await f(`/sessions/${sid}/edges`);
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as {
      kind: string;
      data: { edges: ReadonlyArray<{ edge_type: string }> };
    };
    expect(allBody.kind).toBe("session.edges");
    expect(allBody.data.edges.length).toBe(2);

    const onlySupports = await f(`/sessions/${sid}/edges?edge_type=supports`);
    const onlySupportsBody = (await onlySupports.json()) as {
      data: { edges: ReadonlyArray<{ edge_type: string }> };
    };
    expect(onlySupportsBody.data.edges.length).toBe(1);
    expect(onlySupportsBody.data.edges[0]!.edge_type).toBe("supports");
  });

  it("7. POST /sessions/:id/edges with a valid catalog type emits edge_created", async () => {
    const f = fetchApp(ctx.app);
    const sid = ctx.sessionId;
    const r = await f(`/sessions/${sid}/edges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        edge_type: "verified_by",
        from: { entity_type: "conclusion", entity_id: "c-x" },
        to: { entity_type: "verification", entity_id: "v-x" },
        actor: { name: "alice", type: "human" },
        client_edge_id: "01clientedgexxxxxxxxxxxxxxxx",
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      kind: string;
      data: {
        edge: { edge_type: string; id: string };
        replay: boolean;
      };
    };
    expect(body.kind).toBe("edge.created");
    expect(body.data.edge.edge_type).toBe("verified_by");
    expect(body.data.replay).toBe(false);

    // The event log should now contain an edge_created row with our client_edge_id.
    const events = await f(`/sessions/${sid}/events?limit=200`);
    const eventsBody = (await events.json()) as {
      data: { events: ReadonlyArray<{ id: string; type: string }> };
    };
    const found = eventsBody.data.events.find(
      (e) => e.id === "01clientedgexxxxxxxxxxxxxxxx",
    );
    expect(found?.type).toBe("edge_created");

    // Idempotency: replaying the same client_edge_id returns 200 with replay:true
    // and does NOT create a second edge.
    const replay = await f(`/sessions/${sid}/edges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        edge_type: "verified_by",
        from: { entity_type: "conclusion", entity_id: "c-x" },
        to: { entity_type: "verification", entity_id: "v-x" },
        actor: { name: "alice", type: "human" },
        client_edge_id: "01clientedgexxxxxxxxxxxxxxxx",
      }),
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { data: { replay: boolean } };
    expect(replayBody.data.replay).toBe(true);
  });

  it("8. POST /sessions/:id/edges with unknown edge_type returns 400", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/sessions/${ctx.sessionId}/edges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        edge_type: "made_up_type",
        from: { entity_type: "finding", entity_id: "f1" },
        to: { entity_type: "hypothesis", entity_id: "h1" },
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("unknown_edge_type");
  });
});