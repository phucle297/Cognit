/**
 * apps/dashboard/test/cookie-login.e2e.test.ts — auth cookie flow (E2E).
 *
 * 4 cases that exercise the dashboard's same-origin cookie auth
 * (plan §phase_6 §AC-5). The dashboard lives on :6971 next to the
 * Hono API; the browser `EventSource` cannot set `Authorization`,
 * so the dashboard authenticates by cookie minted from
 * `POST /auth/login`.
 *
 *   a. GET  /auth/login                → 200 + text/html (no auth)
 *   b. POST /auth/login  wrong token   → 401
 *   c. POST /auth/login  correct token → 204 + Set-Cookie cognit_session=…
 *   d. GET  /sessions   (cookie set)   → 200, returns session list
 *
 * Reuses `bootServer` from apps/server/test/helpers.ts via the
 * relative `.js` import path Vitest resolves cross-workspace.
 * `isLoopback=false` + `apiToken` so the auth gate actually fires.
 *
 * Read-only: server helpers untouched; cookies travel as plain
 * `Cookie:` headers (no browser needed).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  bootServer,
  type BootedServer,
} from "../../server/test/helpers.js";

describe("cognit dashboard — cookie-login e2e", () => {
  let server: BootedServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("a. GET /auth/login returns 200 text/html (auth-exempt route)", async () => {
    // Auth config: non-loopback bind + apiToken so the gate fires
    // AND registerAuthRoutes mounts /auth/login. The /auth/login
    // route is exempted from requireBearer, so no credential needed.
    server = await bootServer({
      isLoopback: false,
      apiToken: "correct-token-12345",
    });
    const res = await fetch(`${server.url}/auth/login`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("text/html");
    const body = await res.text();
    // Form marker — the static LOGIN_FORM_HTML in apps/server/src/routes/auth.ts.
    expect(body).toContain("Sign in to Cognit");
  });

  it("b. POST /auth/login with wrong token returns 401", async () => {
    server = await bootServer({
      isLoopback: false,
      apiToken: "correct-token-12345",
    });
    const res = await fetch(`${server.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong-token-9999" }),
    });
    expect(res.status).toBe(401);
  });

  it("c. POST /auth/login with correct token returns 204 + cookie", async () => {
    server = await bootServer({
      isLoopback: false,
      apiToken: "correct-token-12345",
    });
    const res = await fetch(`${server.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "correct-token-12345" }),
    });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get("set-cookie") ?? "";
    // Cookie name defaults to `cognit_session` (see resolveAuthConfig).
    expect(setCookie).toMatch(/cognit_session=correct-token-12345/);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it("d. With cookie set, GET /sessions returns 200 + session list", async () => {
    server = await bootServer({
      isLoopback: false,
      apiToken: "correct-token-12345",
    });
    const res = await fetch(`${server.url}/sessions`, {
      headers: { Cookie: "cognit_session=correct-token-12345" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      kind: string;
      data: { sessions: ReadonlyArray<{ id: string }> };
    };
    expect(json.kind).toBe("sessions.list");
    // The bootServer bootstrap seeds exactly one session.
    expect(Array.isArray(json.data.sessions)).toBe(true);
    expect(json.data.sessions.length).toBeGreaterThanOrEqual(1);
    // The seeded sessionId should be in the list.
    const found = json.data.sessions.find((s) => s.id === server!.sessionId);
    expect(found).toBeDefined();
  });
});
