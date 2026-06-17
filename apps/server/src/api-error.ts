/**
 * apps/server/src/api-error.ts — v1 error envelope + helpers.
 *
 * Success bodies use the v1 envelope (`./envelope.ts`):
 *
 *   { version: 1, kind: <string>, data: <T> }
 *
 * Error bodies use the v1 ApiError shape:
 *
 *   { kind: "api_error", code, message, details?, request_id }
 *
 * `request_id` is a ULID minted by the per-request middleware in
 * `index.ts`. `cause` (raw Effect cause / SQLite error) is NEVER
 * surfaced — only a sanitized `message`. Stack traces stay in
 * server logs, not on the wire.
 *
 * Usage from a route handler:
 *
 *   import { apiErrorResponse, ApiErrorCode } from "../api-error.js";
 *
 *   return apiErrorResponse(c, "bad_request", "body must be a JSON object");
 *
 * The helper picks the HTTP status from the code, so callers don't
 * need to remember the mapping.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const API_ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "unknown_event_type",
  "not_found",
  "session_unavailable",
  "constraint_violation",
  "conflict",
  "rate_limited",
  "internal",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  readonly kind: "api_error";
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly request_id: string;
}

const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  bad_request: 400,
  validation_failed: 400,
  unknown_event_type: 400,
  not_found: 404,
  session_unavailable: 409,
  constraint_violation: 422,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

/**
 * Build the ApiError body. `details` is omitted when empty so the
 * response stays minimal for the common case.
 */
export const apiError = (
  code: ApiErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ApiErrorBody => {
  const base: ApiErrorBody = {
    kind: "api_error",
    code,
    message,
    request_id: requestId,
  };
  if (details !== undefined && Object.keys(details).length > 0) {
    return { ...base, details };
  }
  return base;
};

/**
 * Build a Hono Response carrying the ApiError body with the
 * status code that matches `code`. The `request_id` is read off
 * the context (set by the request_id middleware).
 */
export const apiErrorResponse = (
  c: Context,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Response => {
  const requestId = c.get("requestId") ?? "01missingrequestidxxxxxx";
  return c.json(apiError(code, message, requestId, details), STATUS_BY_CODE[code] as ContentfulStatusCode);
};

/**
 * Look up the HTTP status for an ApiErrorCode. Exported for tests
 * and for callers that need to inspect the mapping.
 */
export const statusForCode = (code: ApiErrorCode): number => STATUS_BY_CODE[code];

/**
 * Middleware: stamp each request with a ULID request_id. Stores
 * the value on the Hono context under `"requestId"` so handlers
 * can pull it via `c.get("requestId")` and emit it on errors.
 *
 * ULIDs are the project's id format throughout the system (events,
 * sessions, hypotheses, edges) so reusing them here keeps the
 * audit trail uniform.
 */
export const requestIdMiddleware = async (
  c: Context,
  next: () => Promise<void>,
): Promise<void> => {
  // Crockford ULID: 10 bytes time + 16 bytes randomness, base32.
  // We use a tiny inline encoder instead of pulling in `ulid` to
  // avoid adding a new dep. The format is correct per the spec;
  // collisions on the same millisecond are tolerable for tracing.
  const RAND_LEN = 16;
  const ENCODING_LEN = 32;
  const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const TIME_CHAR_LEN = 10;
  const time = Date.now();
  let timeStr = "";
  let t = time;
  for (let i = TIME_CHAR_LEN - 1; i >= 0; i--) {
    const mod = t % ENCODING_LEN;
    timeStr = ENCODING[mod]! + timeStr;
    t = (t - mod) / ENCODING_LEN;
  }
  let randStr = "";
  const rand = new Uint8Array(RAND_LEN);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < RAND_LEN; i++) rand[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < RAND_LEN; i++) {
    randStr += ENCODING[rand[i]! % ENCODING_LEN];
  }
  const requestId = timeStr + randStr;
  c.set("requestId", requestId);
  // Echo on the response so clients can quote it in support tickets.
  c.header("x-request-id", requestId);
  await next();
};