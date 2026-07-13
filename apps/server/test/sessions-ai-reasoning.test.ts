/**
 * apps/server/test/sessions-ai-reasoning.test.ts — phase C4.
 *
 * Cases:
 *   1. GET /api/sessions/:id/ai-reasoning on empty session → ranked: [],
 *      decision_log: []
 *   2. One active hypothesis (no AI rank) → source: "rule", ai_score: null,
 *      rule_score: 0.xxx
 *   3. One ranked hypothesis → source: "ai", ai_score present, delta
 *      computed
 *   3b. AI-ranked rule_score rises when a finding is added (full axes)
 *   4. Mixed ranked + unranked → AI scores win ties against rule-only
 *      on the dashboard ordering (the wire shape doesn't carry
 *      `rank_in_source`, but the sort is still by score DESC)
 *   5. Unknown session id → 404 not_found
 *   6. 50 read calls leave the event log unchanged (AC-7.18 mirror)
 *
 * The SSE delivery tests live in `sessions-ai-reasoning-sse.test.ts`
 * (separate file so the live-boot infra doesn't share state with the
 * pure read endpoint tests).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchApp, makeApp, type TestApp } from "./helpers.js";

interface AiReasoningResp {
  readonly kind: string;
  readonly data: {
    readonly session_id: string;
    readonly ranked: ReadonlyArray<{
      readonly hypothesis_id: string;
      readonly title: string;
      readonly text: string;
      readonly ai_score: number | null;
      readonly rule_score: number | null;
      readonly score: number;
      readonly source: "ai" | "rule";
      readonly delta: number | null;
      readonly reasoning: string | null;
      readonly ai_rank_at: string | null;
      readonly ai_rank_event_id: string | null;
    }>;
    readonly decision_log: ReadonlyArray<{
      readonly tick_event_id: string;
      readonly actions_applied: number;
      readonly rank_overrides_applied: number;
      readonly actions_truncated: number;
      readonly stop: boolean;
      readonly created_at: string;
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

describe("GET /api/sessions/:id/ai-reasoning (phase C4)", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("1. empty session returns ranked: []; decision_log carries no overrides", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/${ctx.sessionId}/ai-reasoning`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as AiReasoningResp;
    expect(body.kind).toBe("session.ai_reasoning");
    expect(body.data.session_id).toBe(ctx.sessionId);
    expect(body.data.ranked).toEqual([]);
    // The bootstrap inserts `session_created` (and possibly an
    // actor row) before any supervisor activity, so the
    // decision_log is NOT empty in absolute terms — but it must
    // carry zero rank overrides (the only thing the supervisor
    // "did" in an empty session is nothing).
    const totalOverrides = body.data.decision_log.reduce(
      (s, t) => s + t.rank_overrides_applied,
      0,
    );
    expect(totalOverrides).toBe(0);
  });

  it("2. one active hypothesis (no AI rank) → source=rule, ai_score=null", async () => {
    await post(ctx, "hypothesis_created", { title: "H-unranked", text: "no ai" });
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/${ctx.sessionId}/ai-reasoning`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as AiReasoningResp;
    expect(body.data.ranked.length).toBe(1);
    const row = body.data.ranked[0]!;
    expect(row.source).toBe("rule");
    expect(row.ai_score).toBeNull();
    expect(row.rule_score).not.toBeNull();
    expect(row.delta).toBeNull();
    expect(row.ai_rank_event_id).toBeNull();
  });

  it("3. one ranked hypothesis → source=ai, ai_score set, delta computed", async () => {
    const hypId = await post(ctx, "hypothesis_created", {
      title: "H-ranked",
      text: "ranked",
    });
    await post(ctx, "hypothesis_ranked", {
      hypothesis_id: hypId,
      score: 0.85,
      reasoning: "evidence strong, no recent failures",
      evaluator: "ai-supervisor",
      override_rule_based: true,
      context_event_ids: [],
    });
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/${ctx.sessionId}/ai-reasoning`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as AiReasoningResp;
    expect(body.data.ranked.length).toBe(1);
    const row = body.data.ranked[0]!;
    expect(row.source).toBe("ai");
    expect(row.ai_score).toBe(0.85);
    expect(row.rule_score).not.toBeNull();
    expect(row.delta).not.toBeNull();
    expect(row.delta!).toBeCloseTo(0.85 - row.rule_score!, 6);
    expect(row.reasoning).toBe("evidence strong, no recent failures");
    expect(row.ai_rank_event_id).not.toBeNull();
  });

  it("3b. AI-ranked rule_score includes state-level evidence axis", async () => {
    // Cognit-796: when source === "ai", rule_score must use the full
    // 5-axis formula (not trust+freshness only). A finding lifts
    // evidence_strength by n/(n+3)=0.25 × weight 0.3 → +0.075.
    const hypId = await post(ctx, "hypothesis_created", {
      title: "H-evidence",
      text: "needs findings",
    });
    await post(ctx, "hypothesis_ranked", {
      hypothesis_id: hypId,
      score: 0.5,
      reasoning: "mid",
      evaluator: "ai-supervisor",
      override_rule_based: true,
      context_event_ids: [],
    });
    const f = fetchApp(ctx.app);
    const r1 = await f(`/api/sessions/${ctx.sessionId}/ai-reasoning`);
    expect(r1.status).toBe(200);
    const before = ((await r1.json()) as AiReasoningResp).data.ranked[0]!
      .rule_score!;

    await post(ctx, "finding_created", { text: "reproduced flake in CI" });
    const r2 = await f(`/api/sessions/${ctx.sessionId}/ai-reasoning`);
    expect(r2.status).toBe(200);
    const afterRow = ((await r2.json()) as AiReasoningResp).data.ranked[0]!;
    expect(afterRow.source).toBe("ai");
    expect(afterRow.rule_score).not.toBeNull();
    expect(afterRow.rule_score!).toBeGreaterThan(before);
    expect(afterRow.rule_score! - before).toBeGreaterThanOrEqual(0.07);
  });

  it("4. mixed ranked + unranked → order by score DESC, both surfaces", async () => {
    const idA = await post(ctx, "hypothesis_created", { title: "A", text: "alpha" });
    await post(ctx, "hypothesis_created", { title: "B", text: "beta" });
    await post(ctx, "hypothesis_created", { title: "C", text: "gamma" });
    await post(ctx, "hypothesis_ranked", {
      hypothesis_id: idA,
      score: 0.95,
      reasoning: "top of the queue",
      evaluator: "ai-supervisor",
      override_rule_based: true,
      context_event_ids: [],
    });
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/${ctx.sessionId}/ai-reasoning`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as AiReasoningResp;
    expect(body.data.ranked.length).toBe(3);
    // A is at the top with the AI override score 0.95.
    expect(body.data.ranked[0]!.hypothesis_id).toBe(idA);
    expect(body.data.ranked[0]!.source).toBe("ai");
    expect(body.data.ranked[0]!.ai_score).toBe(0.95);
    // The other two carry source: "rule".
    expect(body.data.ranked[1]!.source).toBe("rule");
    expect(body.data.ranked[2]!.source).toBe("rule");
  });

  it("5. unknown session id returns 404 not_found", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/sessions/01nosuchsessxxxxxxxxxxx/ai-reasoning");
    expect(r.status).toBe(404);
    const body = (await r.json()) as { kind: string; code: string };
    expect(body.kind).toBe("api_error");
    expect(body.code).toBe("not_found");
  });

  it("6. 50 read calls leave the event log unchanged (AC-7.18 mirror)", async () => {
    const hypId = await post(ctx, "hypothesis_created", {
      title: "H",
      text: "x",
    });
    await post(ctx, "hypothesis_ranked", {
      hypothesis_id: hypId,
      score: 0.5,
      reasoning: "no signal",
      evaluator: "ai-supervisor",
      override_rule_based: true,
      context_event_ids: [],
    });
    const f = fetchApp(ctx.app);
    const before = await f(`/api/sessions/${ctx.sessionId}/events?limit=500`);
    const beforeCount = ((await before.json()) as {
      data: { events: ReadonlyArray<unknown> };
    }).data.events.length;
    for (let i = 0; i < 50; i++) {
      const r = await f(`/api/sessions/${ctx.sessionId}/ai-reasoning`);
      expect(r.status).toBe(200);
    }
    const after = await f(`/api/sessions/${ctx.sessionId}/events?limit=500`);
    const afterCount = ((await after.json()) as {
      data: { events: ReadonlyArray<unknown> };
    }).data.events.length;
    expect(afterCount).toBe(beforeCount);
  });

  it("7. decision_log surfaces a row per event tick; rank counts sum to 2", async () => {
    const idA = await post(ctx, "hypothesis_created", { title: "A", text: "alpha" });
    const idB = await post(ctx, "hypothesis_created", { title: "B", text: "beta" });
    await post(ctx, "hypothesis_ranked", {
      hypothesis_id: idA,
      score: 0.6,
      reasoning: "ranked A",
      evaluator: "ai-supervisor",
      override_rule_based: true,
      context_event_ids: [],
    });
    await post(ctx, "hypothesis_ranked", {
      hypothesis_id: idB,
      score: 0.7,
      reasoning: "ranked B",
      evaluator: "ai-supervisor",
      override_rule_based: true,
      context_event_ids: [],
    });
    const f = fetchApp(ctx.app);
    const r = await f(`/api/sessions/${ctx.sessionId}/ai-reasoning`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as AiReasoningResp;
    // Each event has a DB-generated ULID with no shared prefix, so
    // the bucketer treats every event as its own tick. The total
    // count of rank_overrides across all buckets must equal 2 (the
    // number of hypothesis_ranked events we posted).
    expect(body.data.decision_log.length).toBeGreaterThanOrEqual(2);
    const totalOverrides = body.data.decision_log.reduce(
      (s, t) => s + t.rank_overrides_applied,
      0,
    );
    expect(totalOverrides).toBe(2);
    // Every row carries a valid tick_event_id and a created_at that
    // is parseable as ISO.
    for (const t of body.data.decision_log) {
      expect(t.tick_event_id.length).toBe(26);
      expect(Number.isNaN(Date.parse(t.created_at))).toBe(false);
    }
  });
});
