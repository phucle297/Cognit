/**
 * apps/server/test/healthz.test.ts — `GET /healthz`
 *
 * Two cases: 200 with no auth (even when bearer is configured on
 * other routes), and the v1 envelope shape.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";

describe("cognit server — /healthz", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("returns 200 with no auth required", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/healthz");
    expect(r.status).toBe(200);
  });

  it("returns the v1 envelope shape { version, kind, data: { status } }", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/healthz");
    const body = (await r.json()) as { version: number; kind: string; data: { status: string } };
    expect(body.version).toBe(1);
    expect(body.kind).toBe("healthz");
    expect(body.data.status).toBe("ok");
  });
});
