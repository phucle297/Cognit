/**
 * apps/server/src/envelope.ts — v1 JSON envelope.
 *
 * Mirrors `packages/cli/src/output.ts` exactly:
 *   { version: 1, kind: "<command>", data: <payload> }
 *
 * The server and CLI emit the same shape so a single parser works
 * for both. We intentionally do not import from @cognit/cli (that
 * would pull a commander dep into the server); the envelope
 * shape is duplicated here.
 *
 * Error bodies use the v1 ApiError shape (see `./api-error.ts`):
 *
 *   { kind: "api_error", code, message, details?, request_id }
 *
 * `code` is one of: `bad_request`, `validation_failed`,
 * `unknown_event_type`, `not_found`, `session_unavailable`,
 * `constraint_violation`, `conflict`, `rate_limited`, `internal`.
 * The HTTP status is derived from the code via
 * `statusForCode(code)` in `./api-error.ts`.
 */
export const ENVELOPE_VERSION = 1 as const;

export interface EnvelopeV1<T> {
  readonly version: typeof ENVELOPE_VERSION;
  readonly kind: string;
  readonly data: T;
}

export const envelope = <T>(kind: string, data: T): EnvelopeV1<T> => ({
  version: ENVELOPE_VERSION,
  kind,
  data,
});
