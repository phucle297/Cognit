/**
 * apps/server/test/rules.test.ts — phase 8 (8g.5) rules CRUD route.
 *
 * Cases:
 *   1. GET /api/rules on empty project returns rules: []
 *   2. POST /api/rules with valid v1 predicate appends and surfaces in list
 *   3. POST /api/rules rejects malformed predicate with 400
 *   4. PATCH /api/rules/:id toggles enabled flag (re-emit)
 *   5. DELETE /api/rules/:id soft-deletes (filtered from list)
 *   6. PATCH on unknown id returns 404
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchApp, makeApp, type TestApp } from "./helpers.js";

interface ListResp {
  readonly kind: string;
  readonly data: {
    readonly rules: ReadonlyArray<{
      readonly id: string;
      readonly enabled: boolean;
      readonly deleted: boolean;
      readonly source: "db" | "yaml";
      readonly reason: string;
    }>;
  };
}

interface AddResp {
  readonly kind: string;
  readonly data: {
    readonly rule: {
      readonly id: string;
      readonly session_id: string;
      readonly enabled: boolean;
    };
  };
}

const validRule = {
  when: { kind: "event.type", equals: "observation_recorded" },
  then: { kind: "block" },
  reason: "no observations allowed in this session",
};

describe("rules CRUD (phase 8 — 8g.5)", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("1. GET /api/rules on empty project → rules: []", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/rules");
    expect(r.status).toBe(200);
    const body = (await r.json()) as ListResp;
    expect(body.kind).toBe("rules.list");
    expect(body.data.rules).toEqual([]);
  });

  it("2. POST /api/rules with valid predicate → 201 + surfaces in list", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validRule),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as AddResp;
    expect(body.data.rule.enabled).toBe(true);
    expect(typeof body.data.rule.id).toBe("string");
    const list = await f("/api/rules");
    const listBody = (await list.json()) as ListResp;
    expect(listBody.data.rules.length).toBe(1);
    expect(listBody.data.rules[0]!.id).toBe(body.data.rule.id);
    expect(listBody.data.rules[0]!.source).toBe("db");
    expect(listBody.data.rules[0]!.reason).toBe(validRule.reason);
  });

  it("3. POST /api/rules with malformed predicate → 400 validation_failed", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        when: { kind: "not_a_real_predicate", value: 1 },
        then: { kind: "block" },
        reason: "x",
      }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { kind: string; code: string };
    expect(body.kind).toBe("api_error");
    expect(body.code).toBe("validation_failed");
  });

  it("4. PATCH /api/rules/:id toggles enabled (re-emit)", async () => {
    const f = fetchApp(ctx.app);
    const add = await f("/api/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validRule),
    });
    const addBody = (await add.json()) as AddResp;
    const id = addBody.data.rule.id;
    const patch = await f(`/api/rules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as {
      data: { rule: { enabled: boolean } };
    };
    expect(patchBody.data.rule.enabled).toBe(false);
    // List still surfaces the rule but with enabled=false.
    const list = await f("/api/rules");
    const listBody = (await list.json()) as ListResp;
    const found = listBody.data.rules.find((r) => r.id === id);
    expect(found?.enabled).toBe(false);
  });

  it("5. DELETE /api/rules/:id soft-deletes (drops from list)", async () => {
    const f = fetchApp(ctx.app);
    const add = await f("/api/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validRule),
    });
    const id = ((await add.json()) as AddResp).data.rule.id;
    const del = await f(`/api/rules/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const list = await f("/api/rules");
    const listBody = (await list.json()) as ListResp;
    expect(listBody.data.rules.find((r) => r.id === id)).toBeUndefined();
  });

  it("6. PATCH on unknown id → 404 not_found", async () => {
    const f = fetchApp(ctx.app);
    const r = await f(`/api/rules/rule_does_not_exist`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { kind: string; code: string };
    expect(body.kind).toBe("api_error");
    expect(body.code).toBe("not_found");
  });
});
