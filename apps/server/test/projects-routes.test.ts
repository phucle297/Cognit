/**
 * apps/server/test/projects-routes.test.ts — `GET /projects`, `POST /projects`.
 *
 * 5 cases (plan §5.4.3):
 *   1. GET /projects returns the bootstrap project (list not empty).
 *   2. POST /projects with a valid body returns 201 + kind "project.created".
 *   3. POST /projects with missing name returns 400 validation_failed.
 *   4. POST /projects with empty name returns 400 validation_failed.
 *   5. POST /projects then GET /projects lists the new project.
 *
 * The bootstrap in `helpers.ts` inserts a single project row at
 * startup so the list endpoint is never empty in test fixtures.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";

describe("cognit server — /projects routes", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("GET /projects returns at least the bootstrap project", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/projects");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      version: number;
      kind: string;
      data: { projects: Array<{ id: string; name: string }> };
    };
    expect(body.version).toBe(1);
    expect(body.kind).toBe("projects.list");
    expect(Array.isArray(body.data.projects)).toBe(true);
    expect(body.data.projects.length).toBeGreaterThanOrEqual(1);
    const names = body.data.projects.map((p) => p.name);
    expect(names).toContain("test");
  });

  it("POST /projects with valid body returns 201 + project.created", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "acme", repo_url: "https://github.com/acme/widgets" }),
    });
    if (r.status !== 201) {
      const txt = await r.text();
      throw new Error(`expected 201, got ${r.status}: ${txt}`);
    }
    const body = (await r.json()) as {
      version: number;
      kind: string;
      data: { project: { id: string; name: string; repo_url: string } };
    };
    expect(body.kind).toBe("project.created");
    expect(body.data.project.name).toBe("acme");
    expect(body.data.project.repo_url).toBe("https://github.com/acme/widgets");
    expect(body.data.project.id).toMatch(/^[0-9A-Z]{20,30}$/);
  });

  it("POST /projects with missing name returns 400 validation_failed (v1 envelope)", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_url: "https://example.com" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { kind: string; code: string; message: string; request_id: string };
    expect(body.kind).toBe("api_error");
    expect(body.code).toBe("validation_failed");
    expect(body.message).toContain("name");
    expect(typeof body.request_id).toBe("string");
    expect(body.request_id.length).toBeGreaterThan(0);
  });

  it("POST /projects with empty name returns 400 validation_failed (v1 envelope)", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { kind: string; code: string; message: string };
    expect(body.kind).toBe("api_error");
    expect(body.code).toBe("validation_failed");
  });

  it("POST /projects on internal failure returns 500 with v1 envelope (no leaked cause)", async () => {
    // Force an internal failure by monkey-patching the runtime's
    // runPromiseExit to return a Failure with a synthetic DbError
    // cause. The route must swallow the raw cause and emit the
    // v1 `api_error` envelope, not the raw DbError.
    const original = ctx.runtime.runPromiseExit;
    (ctx.runtime as unknown as { runPromiseExit: typeof original }).runPromiseExit = (async <A, E>(_eff: Effect.Effect<A, E, never>) => {
      return {
        _tag: "Failure" as const,
        cause: new Error("synthetic DbError: SQLITE_CONSTRAINT: simulated failure for envelope test"),
      };
    }) as typeof original;
    try {
      const f = fetchApp(ctx.app);
      const r = await f("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "boom" }),
      });
      expect(r.status).toBe(500);
      const body = (await r.json()) as {
        kind: string;
        code: string;
        message: string;
        request_id: string;
      };
      // v1 envelope shape: kind=api_error, code=internal, no `cause` field.
      expect(body.kind).toBe("api_error");
      expect(body.code).toBe("internal");
      expect(body.message).toBe("project.create failed");
      expect(typeof body.request_id).toBe("string");
      expect(body.request_id.length).toBeGreaterThan(0);
      // Sanity: raw cause keys MUST NOT appear on the wire.
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("DbError");
      expect(raw).not.toContain("SQLITE_");
      expect(raw).not.toContain("cause");
      expect(raw).not.toContain("simulated");
    } finally {
      (ctx.runtime as unknown as { runPromiseExit: typeof original }).runPromiseExit = original;
    }
  });

  it("POST /projects then GET /projects lists the new project", async () => {
    const f = fetchApp(ctx.app);
    const post = await f("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "newproj" }),
    });
    expect(post.status).toBe(201);
    const get = await f("/api/projects");
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      data: { projects: Array<{ name: string }> };
    };
    const names = body.data.projects.map((p) => p.name);
    expect(names).toContain("newproj");
  });
});