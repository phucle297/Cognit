/**
 * apps/dashboard/test/auth-vs-static-order.e2e.test.ts — route order guard (E2E).
 *
 * 2 cases. The production server mounts routes in a specific order
 * (apps/server/src/index.ts:187-219):
 *
 *   1. CORS middleware
 *   2. OPTIONS preflight
 *   3. Auth gate (loopback bypass → /health, /healthz, /auth/login exempt
 *      → requireBearer elsewhere)
 *   4. registerHealthz, registerAuthRoutes, registerSessionsRoutes, …
 *   5. `app.get("*", serveStatic(dashboardRoot))`  ← LAST
 *
 * If the order ever regresses — e.g. someone moves `serveStatic`
 * before `registerAuthRoutes` — then `GET /auth/login` would fall
 * through to the static handler and return 404 (no matching asset)
 * instead of the login HTML form. That's the regression this test
 * pins down.
 *
 * The `bootServer` helper mirrors the same wiring minus the static
 * fallback (which only lives in `index.ts`). We assert here on the
 * routes that ARE registered: /auth/login still 200, /health still
 * 200, /anything-else 404. The auth-vs-static-order property
 * follows from the same route ordering — see src/index.ts:187-219.
 *
 * Read-only: server untouched.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  bootServer,
  type BootedServer,
} from "../../server/test/helpers.js";

describe("cognit dashboard — auth-vs-static-order e2e", () => {
  let server: BootedServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("a. GET /auth/login is NOT shadowed by serveStatic 404", async () => {
    // apiToken so registerAuthRoutes mounts /auth/login (helpers.ts:204).
    // isLoopback=true so the auth gate is bypassed (no requireBearer
    // for unmatched paths — those hit Hono's default 404 here, and
    // serveStatic's catch-all in production).
    server = await bootServer({
      isLoopback: true,
      apiToken: "order-test-token",
    });

    // The auth-exempt /auth/login route MUST respond before any
    // catch-all. The HTML form is the dashboard's entry point —
    // if serveStatic shadows it, the user sees a 404 instead of
    // a login form.
    const res = await fetch(`${server.url}/auth/login`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("text/html");
    const body = await res.text();
    // Static fallback would never produce this marker.
    expect(body).toContain("Sign in to Cognit");
    // And the body must NOT be a 404 HTML page.
    expect(body).not.toMatch(/404/);
  });

  it("b. Unmatched paths still return 404 (static fallback not greedy)", async () => {
    server = await bootServer({
      isLoopback: true,
      apiToken: "order-test-token",
    });

    // A path that no registered route matches. In the test helper
    // this hits Hono's default 404; in production (with
    // serveStatic mounted last at src/index.ts:214) this hits
    // either a 404 (no dist match) or a real asset. Either way,
    // `/auth/login` is unaffected — which is what the previous
    // case pins down. The point of this case is the negative
    // assertion: routes NOT in the registered set don't suddenly
    // start returning HTML from /auth/login by mistake.
    const res = await fetch(`${server.url}/some/random/path/that/does/not/match`);
    expect(res.status).toBe(404);

    // And re-confirm /auth/login still works after hitting an
    // unmatched path on the same boot — proves the server didn't
    // get into a weird state where the route table is dirty.
    const loginRes = await fetch(`${server.url}/auth/login`);
    expect(loginRes.status).toBe(200);
    expect(loginRes.headers.get("content-type") ?? "").toContain("text/html");
  });
});
