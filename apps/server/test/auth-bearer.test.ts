/**
 * apps/server/test/auth-bearer.test.ts — opt-in bearer middleware.
 *
 * 7 cases:
 *   1. token set + non-loopback → 401 without bearer, 200 with
 *      `Authorization: Bearer <token>`.
 *   2. token set + loopback → 200 without bearer (loopback is
 *      OS-isolated; the local-first posture is unauthenticated).
 *   3. (phase 5.3) GET /health alias returns 200 without bearer when
 *      auth is enforced. Same shape as /healthz.
 *   4. (phase 5.3) POST /auth/login with correct token sets a
 *      HttpOnly + SameSite=Strict cookie.
 *   5. (phase 5.3) POST /auth/login with wrong token returns 401.
 *   6. (phase 5.3) Cookie-authenticated GET /sessions works (same
 *      bypass the dashboard's EventSource will use).
 *   7. (phase 5.3) GET /auth/login serves the HTML form even when
 *      auth is enforced (login is the entry point).
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

    // ---- phase 5.3 additions ----

    it("GET /health alias is unauthenticated and returns the same envelope shape", async () => {
      const f = fetchApp(ctx.app);
      const r = await f("/health");
      expect(r.status).toBe(200);
      const body = (await r.json()) as { version: number; kind: string; data: { status: string } };
      expect(body.version).toBe(1);
      expect(body.kind).toBe("healthz");
      expect(body.data.status).toBe("ok");
    });

    it("GET /auth/login serves the HTML form even when auth is enforced", async () => {
      const f = fetchApp(ctx.app);
      const r = await f("/auth/login");
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      const text = await r.text();
      expect(text).toMatch(/<form[^>]+action="\/auth\/login"/);
    });

    it("POST /auth/login with the correct token sets HttpOnly + SameSite=Strict cookie", async () => {
      const f = fetchApp(ctx.app);
      const r = await f("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN }),
      });
      expect(r.status).toBe(204);
      const setCookie = r.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/^cognit_session=/);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Strict/i);
      // Non-loopback bind → Secure flag MUST be set.
      expect(setCookie).toMatch(/Secure/i);
      expect(setCookie).toMatch(/Path=\//);
      expect(setCookie).toMatch(/Max-Age=/);
    });

    it("POST /auth/login with the wrong token returns 401", async () => {
      const f = fetchApp(ctx.app);
      const r = await f("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wrong-token" }),
      });
      expect(r.status).toBe(401);
    });

    it("GET /sessions with the cookie set by /auth/login is allowed", async () => {
      const f = fetchApp(ctx.app);
      const login = await f("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN }),
      });
      expect(login.status).toBe(204);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
      const r = await f("/sessions", { headers: { cookie } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { kind: string };
      expect(body.kind).toBe("sessions.list");
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
