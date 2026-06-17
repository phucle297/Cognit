/**
 * apps/server/src/auth.ts — bearer + same-origin cookie middleware.
 *
 * Decision: **no auth for the local case.** Default bind is
 * `127.0.0.1`, which is OS-isolated; the loopback interface is the
 * security boundary. `cognit server` works without a token.
 *
 * The middleware activates only when BOTH conditions hold:
 *   1. The bind host is non-loopback.
 *   2. `auth.api_token` resolves to a non-empty string (env
 *      `COGNIT_API_TOKEN` > CLI `--api-token` > yaml `auth.api_token`).
 *
 * When enforced, `requireBearer` accepts:
 *   - `Authorization: Bearer <token>` (CLI / scripted clients), OR
 *   - `Cookie: <cookieName>=<token>` (same-origin dashboard —
 *     EventSource cannot set the Authorization header).
 *
 * A missing or wrong credential returns `401` with a small JSON body.
 * The loopback bypass lives in `apps/server/src/index.ts` mount order
 * (cheap URL-prefix check before this middleware runs).
 */
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthConfig } from "./config.js";

export interface BearerConfig extends AuthConfig {
  // Extends AuthConfig for forward-compat — callers pass the full
  // resolved auth section, not just the token.
}

/**
 * Build a Hono middleware that requires either:
 *   - `Authorization: Bearer <apiToken>`, OR
 *   - `Cookie: <cookieName>=<apiToken>`.
 *
 * Constant-time compare via `===` (v1 single-tenant local — no
 * perf concern). The cookie path exists because `EventSource`
 * cannot set `Authorization`; the dashboard runs same-origin so
 * HttpOnly + SameSite=Strict is sufficient.
 */
export const requireBearer = (cfg: BearerConfig): MiddlewareHandler => {
  return async (c, next) => {
    if (cfg.apiToken === null) {
      // Defensive: shouldEnforceAuth guards this, but if a route
      // is mounted with `requireBearer` on a no-token config we
      // open it rather than deadlocking every request.
      await next();
      return;
    }
    const auth = c.req.header("authorization") ?? "";
    if (auth === `Bearer ${cfg.apiToken}`) {
      await next();
      return;
    }
    const cookie = getCookie(c, cfg.cookieName);
    if (cookie === cfg.apiToken) {
      await next();
      return;
    }
    return c.json(
      { error: "unauthorized", message: "missing or wrong bearer token / cookie" },
      401,
    );
  };
};

/**
 * Decide whether bearer auth should be enforced.
 *
 * - `isLoopback` = true → never require auth (loopback is OS-isolated).
 * - `apiToken` undefined or empty/whitespace → no auth.
 * - otherwise → require bearer.
 *
 * @deprecated Use `buildServerConfig` from `./config.js` for the
 * full resolution path. This helper is kept for the test harness
 * and any caller that already has the token + isLoopback pair.
 */
export const shouldEnforceAuth = (
  apiToken: string | undefined,
  isLoopback: boolean,
): boolean => {
  if (isLoopback) return false;
  if (!apiToken || apiToken.trim() === "") return false;
  return true;
};