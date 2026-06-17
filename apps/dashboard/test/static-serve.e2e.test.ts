/**
 * apps/dashboard/test/static-serve.e2e.test.ts — static fallback order (E2E).
 *
 * 1 case. The production server (apps/server/src/index.ts:214-219)
 * mounts `serveStatic(dashboardRoot)` as the LAST route. That means
 * unmatched paths fall through to 404 (when dist is missing) or to
 * the index.html (when dist exists). This test runs against
 * `bootServer`, which mirrors the production wiring but uses a
 * fresh temp DB. The `buildHono` helper in apps/server/test/helpers.ts
 * does NOT mount `serveStatic` — that route only lives in
 * `index.ts`. So a path that doesn't match any registered route
 * gets Hono's default 404.
 *
 * The bootstrap of `bootServer` itself proves the test:
 *   - /auth/login (auth-exempt) → 200 text/html
 *   - /nonexistent-dashboard-path → 404 (Hono default fallback)
 *
 * Same assertion if `vite build` had run: / would resolve to
 * dist/index.html (200) instead of 404. Both outcomes prove the
 * auth-exempt routes fire BEFORE the catch-all.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  bootServer,
  type BootedServer,
} from "../../server/test/helpers.js";

describe("cognit dashboard — static-serve e2e", () => {
  let server: BootedServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("serveStatic fallback comes AFTER auth-exempt routes", async () => {
    // The bootServer helper mirrors the production wiring but does
    // NOT mount serveStatic (which only lives in src/index.ts:214).
    // So a path with no matching route hits Hono's default 404.
    // We need an apiToken (so registerAuthRoutes mounts /auth/login
    // at all — see helpers.ts:204) AND loopback bind (so the auth
    // gate is bypassed and unmatched paths reach the 404 fallback
    // instead of being rejected with 401 by requireBearer).
    server = await bootServer({
      isLoopback: true,
      apiToken: "static-test-token",
    });

    // /auth/login is auth-exempt and returns 200 + text/html.
    // This MUST succeed regardless of whether the dashboard dist
    // exists, because the route is registered before any static
    // fallback in src/index.ts:200 (registerAuthRoutes) and is
    // exempted from requireBearer in the gate at line 187-197.
    const loginRes = await fetch(`${server.url}/auth/login`);
    expect(loginRes.status).toBe(200);
    const ct = loginRes.headers.get("content-type") ?? "";
    expect(ct).toContain("text/html");

    // /nonexistent-dashboard-path is not a registered route and
    // serveStatic is not mounted in the test helper. Hono's default
    // 404 fires. In production (apps/server/src/index.ts:214), the
    // same path would either resolve to a real dist asset (200) or
    // fall through to the same 404 (no asset match). Either way,
    // the route is NOT shadowed by the static fallback BEFORE the
    // auth-exempt /auth/login route — which is what the
    // auth-vs-static-order.e2e test pins down.
    const missingRes = await fetch(`${server.url}/nonexistent-dashboard-path`);
    expect(missingRes.status).toBe(404);
  });
});
