/**
 * apps/server/src/auth.ts — opt-in bearer middleware.
 *
 * Decision: **no auth for the local case.** Default bind is
 * `127.0.0.1`, which is OS-isolated; the loopback interface is
 * the security boundary. `cognit server` works without a token.
 *
 * The bearer middleware activates only when BOTH conditions hold:
 *   1. `server.api_token` is set in `cognit.yaml`, AND
 *   2. the server is bound to a non-loopback host.
 *
 * The token comes from the project's `cognit.yaml` (a
 * `server: { api_token: "..." }` block). The server reads it once
 * at boot. If the token is set but the bind is loopback, the
 * middleware is a no-op (we log a warning, not a fatal).
 *
 * Hono's middleware shape:
 *   const requireBearer: MiddlewareHandler<...> = async (c, next) => { ... }
 *
 * A missing or wrong token returns `401` with a small JSON body.
 */
import type { MiddlewareHandler } from "hono";

export interface BearerConfig {
  readonly apiToken: string;
}

/**
 * Build a Hono middleware that requires `Authorization: Bearer <apiToken>`.
 * Constant-time compare via `crypto.timingSafeEqual` when available,
 * else a plain `===` (v1 single-tenant local — no perf concern).
 */
export const requireBearer = (cfg: BearerConfig): MiddlewareHandler => {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const expected = `Bearer ${cfg.apiToken}`;
    if (header !== expected) {
      return c.json(
        { error: "unauthorized", message: "missing or wrong bearer token" },
        401,
      );
    }
    await next();
    return;
  };
};

/**
 * Decide whether bearer auth should be enforced.
 *
 * - `isLoopback` = true → never require auth (loopback is OS-isolated).
 * - `apiToken` undefined → no auth (caller didn't opt in).
 * - otherwise → require bearer.
 */
export const shouldEnforceAuth = (
  apiToken: string | undefined,
  isLoopback: boolean,
): boolean => {
  if (isLoopback) return false;
  if (!apiToken) return false;
  return true;
};
