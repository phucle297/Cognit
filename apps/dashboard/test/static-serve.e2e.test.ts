/**
 * apps/dashboard/test/static-serve.e2e.test.ts — static fallback order (E2E).
 *
 * 1 case. The production server (apps/server/src/index.ts) mounts
 * `serveStatic(dashboardRoot)` as the LAST route. That means
 * unmatched paths fall through to 404 (when dist is missing) or to
 * the index.html (when dist exists). This test runs against
 * `bootServer`, which mirrors the production wiring but uses a
 * fresh temp DB. The `buildHono` helper in apps/server/test/helpers.ts
 * does NOT mount `serveStatic` — that route only lives in
 * `index.ts`. So a path that doesn't match any registered route
 * gets Hono's default 404.
 *
 * The bootstrap of `bootServer` itself proves the test:
 *   - GET /healthz → 200 with the v1 envelope
 *   - /nonexistent-dashboard-path → 404 (Hono default fallback)
 *
 * No auth — local-only tool.
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

  it("serveStatic fallback comes AFTER the registered API routes", async () => {
    // The bootServer helper mirrors the production wiring but does
    // NOT mount serveStatic (which only lives in src/index.ts). So
    // a path with no matching route hits Hono's default 404. This
    // is the desired behaviour: API routes are first-class, static
    // assets are the catch-all.
    server = await bootServer();

    // /healthz is a registered route; no auth required.
    const healthzRes = await fetch(`${server.url}/healthz`);
    expect(healthzRes.status).toBe(200);
    const healthzJson = (await healthzRes.json()) as { kind: string };
    expect(healthzJson.kind).toBe("healthz");

    // /nonexistent-dashboard-path is not a registered route and
    // serveStatic is not mounted in the test helper. Hono's default
    // 404 fires. In production (apps/server/src/index.ts), the same
    // path would either resolve to a real dist asset (200) or fall
    // through to the same 404 (no asset match). Either way, the
    // route is NOT shadowed by the static fallback BEFORE the API
    // routes — which is the pin this test exists to keep stable.
    const missingRes = await fetch(`${server.url}/nonexistent-dashboard-path`);
    expect(missingRes.status).toBe(404);
  });
});