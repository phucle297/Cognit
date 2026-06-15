/**
 * apps/server/test/auth-bearer.test.ts — opt-in bearer middleware.
 *
 * 2 cases:
 *   1. token set + non-loopback → 401 without bearer, 200 with
 *      `Authorization: Bearer <token>`.
 *   2. token set + loopback → 200 without bearer (loopback is
 *      OS-isolated; the local-first posture is unauthenticated).
 *
 * The decision (no auth for the local case) lives in
 * `apps/server/src/auth.ts:shouldEnforceAuth`. The test exercises
 * the production wiring via `makeAppWithAuth` so any future
 * refactor that breaks the wiring fails here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeAppWithAuth, fetchApp, type TestApp } from "./helpers.js";

const TOKEN = "test-secret-token-1234567890";

describe("cognit server — bearer auth", () => {
  describe("non-loopback bind with token set (auth enforced)", () => {
    let ctx: TestApp;
    beforeEach(async () => {
      ctx = await makeAppWithAuth({ apiToken: TOKEN, isLoopback: false });
    });
    afterEach(async () => {
      await ctx.close();
    });

    it("GET /sessions without bearer returns 401", async () => {
      const f = fetchApp(ctx.app);
      const r = await f("/sessions");
      expect(r.status).toBe(401);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("unauthorized");
    });

    it("GET /sessions with the correct bearer returns 200", async () => {
      const f = fetchApp(ctx.app);
      const r = await f("/sessions", { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { kind: string };
      expect(body.kind).toBe("sessions.list");
    });

    it("GET /sessions with the wrong bearer returns 401", async () => {
      const f = fetchApp(ctx.app);
      const r = await f("/sessions", { headers: { authorization: "Bearer wrong-token" } });
      expect(r.status).toBe(401);
    });

    it("GET /healthz is unauthenticated even when auth is enforced", async () => {
      // The probe endpoint must remain open so the orchestrator's
      // healthcheck works regardless of token config.
      const f = fetchApp(ctx.app);
      const r = await f("/healthz");
      expect(r.status).toBe(200);
    });
  });

  describe("loopback bind with token set (auth bypassed)", () => {
    let ctx: TestApp;
    beforeEach(async () => {
      ctx = await makeAppWithAuth({ apiToken: TOKEN, isLoopback: true });
    });
    afterEach(async () => {
      await ctx.close();
    });

    it("GET /sessions without bearer still returns 200 on loopback", async () => {
      const f = fetchApp(ctx.app);
      const r = await f("/sessions");
      expect(r.status).toBe(200);
      const body = (await r.json()) as { kind: string };
      expect(body.kind).toBe("sessions.list");
    });
  });
});
