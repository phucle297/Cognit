/**
 * apps/server/src/routes/auth.ts — dashboard cookie login.
 *
 *   GET  /auth/login   → 200, tiny HTML form (input[type=password]).
 *   POST /auth/login   → body `{token: string}`. If it matches
 *                       `cfg.apiToken`, sets the cookie
 *                       `cfg.cookieName=<token>` with HttpOnly,
 *                       SameSite=Strict, Secure (when non-loopback),
 *                       Path=/, Max-Age=86400. 204 on success, 401
 *                       on mismatch.
 *
 * Why a cookie and not a bearer: the dashboard is served from the
 * same origin (:6971). Browser `EventSource` (used for SSE) cannot
 * set the `Authorization` header — it is a no-header API. A
 * same-origin HttpOnly cookie is the standard fix.
 *
 * The cookie is checked by `requireBearer` as a fallback before the
 * 401 response, so the rest of the API surface (`/sessions/*`,
 * `/events/*`, `/projects/*`, etc.) accepts either `Authorization:
 * Bearer X` OR `Cookie: cognit_session=X`.
 */
import { Hono } from "hono";
import type { AuthConfig } from "../config.js";

const COOKIE_MAX_AGE_SECONDS = 86_400;

const LOGIN_FORM_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Cognit — API token</title>
  <style>
    body { font: 14px/1.4 system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.1rem; margin: 0 0 1rem; }
    form { display: grid; gap: 0.5rem; }
    input[type=password] { padding: 0.5rem; font: inherit; border: 1px solid #ccc; border-radius: 4px; }
    button { padding: 0.5rem 1rem; font: inherit; background: #2563eb; color: #fff; border: 0; border-radius: 4px; cursor: pointer; }
    .err { color: #b91c1c; }
  </style>
</head>
<body>
  <h1>Sign in to Cognit</h1>
  <p>Paste your <code>COGNIT_API_TOKEN</code>. The server sets a session cookie on success.</p>
  <form method="post" action="/auth/login">
    <input type="password" name="token" autofocus required minlength="8" placeholder="API token" />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;

const isString = (x: unknown): x is string => typeof x === "string" && x.length > 0;

interface PostLoginBody {
  readonly token?: unknown;
}

const parseBody = (raw: unknown): { ok: true; value: PostLoginBody } | { ok: false; error: string } => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.token !== undefined && !isString(obj.token)) {
    return { ok: false, error: "token must be a string" };
  }
  return { ok: true, value: { token: obj.token } };
};

export const registerAuthRoutes = (app: Hono, cfg: AuthConfig): void => {
  // GET — serve a tiny HTML form. No auth: the form is the entry
  // point, not a protected resource.
  app.get("/auth/login", (c) => {
    c.header("content-type", "text/html; charset=utf-8");
    c.header("cache-control", "no-store");
    return c.body(LOGIN_FORM_HTML, 200);
  });

  // POST — accept the token, set the cookie.
  app.post("/auth/login", async (c) => {
    // If no token is configured, the server is fully open; refuse
    // to mint a cookie because there is nothing to match against.
    if (cfg.apiToken === null) {
      return c.json({ error: "auth_disabled", message: "server has no api_token configured" }, 400);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      // Form-encoded fallback: the HTML form posts `application/x-www-form-urlencoded`.
      try {
        const text = await c.req.text();
        const params = new URLSearchParams(text);
        const t = params.get("token");
        raw = t === null ? {} : { token: t };
      } catch {
        return c.json({ error: "bad_request", message: "body is neither JSON nor form-encoded" }, 400);
      }
    }

    const parsed = parseBody(raw);
    if (!parsed.ok) {
      return c.json({ error: "bad_request", message: parsed.error }, 400);
    }
    if (!isString(parsed.value.token)) {
      return c.json({ error: "bad_request", message: "token is required" }, 400);
    }
    if (parsed.value.token !== cfg.apiToken) {
      // Constant-time compare? v1 single-tenant local — skip.
      return c.json({ error: "unauthorized", message: "token does not match" }, 401);
    }

    const secure = cfg.cookieSecure;
    const cookie = [
      `${cfg.cookieName}=${parsed.value.token}`,
      "HttpOnly",
      "SameSite=Strict",
      `Path=/`,
      `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    ];
    if (secure) cookie.push("Secure");
    c.header("set-cookie", cookie.join("; "));
    return c.body(null, 204);
  });
};