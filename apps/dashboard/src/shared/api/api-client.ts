/**
 * apps/dashboard/src/shared/api/api-client.ts — fetch wrapper.
 *
 * FSD layer: shared. Used by every layer above (pages, widgets,
 * features). All requests are same-origin — no auth, no cookies,
 * no bearer header.
 *
 * Wire format (mirrors apps/server/src/envelope.ts and
 * apps/server/src/api-error.ts):
 *   success → { version: 1, kind: string, data: T }
 *   error   → { kind: "api_error", code, message, details?, request_id }
 *
 * The error case is normalised into a thrown `Error` whose
 * `.api` property carries the full ApiError body, so callers
 * can render `request_id` in support messages.
 */

export type EnvelopeV1<T> = {
  readonly version: 1;
  readonly kind: string;
  readonly data: T;
};

export type ApiErrorCode =
  | "bad_request"
  | "validation_failed"
  | "unknown_event_type"
  | "not_found"
  | "session_unavailable"
  | "constraint_violation"
  | "conflict"
  | "rate_limited"
  | "internal";

export type ApiErrorBody = {
  readonly kind: "api_error";
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly request_id: string;
};

export class ApiError extends Error {
  readonly api: ApiErrorBody;
  constructor(api: ApiErrorBody) {
    super(api.message);
    this.name = "ApiError";
    this.api = api;
  }
}

const isApiErrorBody = (x: unknown): x is ApiErrorBody => {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  return obj.kind === "api_error" && typeof obj.code === "string" && typeof obj.message === "string" && typeof obj.request_id === "string";
};

const isEnvelope = <T>(x: unknown): x is EnvelopeV1<T> => {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  return obj.version === 1 && typeof obj.kind === "string" && "data" in obj;
};

const resolveUrl = (path: string): string => {
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/")) return path;
  return `/${path}`;
};

export type ApiFetchInit = Omit<RequestInit, "body" | "headers"> & {
  body?: unknown;
  headers?: Record<string, string>;
};

/**
 * Issue a same-origin request. Resolves with the unwrapped
 * `data` field; rejects with an `ApiError` on the error envelope
 * or a regular `Error` on transport failure.
 */
export const apiFetch = async <T>(path: string, init: ApiFetchInit = {}): Promise<T> => {
  const { body, headers, ...rest } = init;
  const finalHeaders: Record<string, string> = {
    accept: "application/json",
    ...headers,
  };
  let payload: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (typeof body === "string" || body instanceof FormData || body instanceof Blob) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      finalHeaders["content-type"] = finalHeaders["content-type"] ?? "application/json";
    }
  }

  let res: Response;
  try {
    res = await fetch(resolveUrl(path), {
      ...rest,
      headers: finalHeaders,
      ...(payload !== undefined ? { body: payload } : {}),
    });
  } catch (err) {
    const requestId = "01networkerrorxxxxxxxx";
    const api: ApiErrorBody = {
      kind: "api_error",
      code: "internal",
      message: err instanceof Error ? err.message : "network error",
      request_id: requestId,
    };
    throw new ApiError(api);
  }

  // 204 No Content — caller chose not to receive a body.
  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  let parsed: unknown = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON: treat as a transport-level error.
      if (!res.ok) {
        throw new ApiError({
          kind: "api_error",
          code: "internal",
          message: res.statusText || `HTTP ${res.status}`,
          request_id: res.headers.get("x-request-id") ?? "01parseerrorxxxxxxxxxx",
        });
      }
      throw new ApiError({
        kind: "api_error",
        code: "internal",
        message: "response is not JSON",
        request_id: res.headers.get("x-request-id") ?? "01parseerrorxxxxxxxxxx",
      });
    }
  }

  if (isApiErrorBody(parsed)) {
    throw new ApiError(parsed);
  }

  if (!res.ok) {
    throw new ApiError({
      kind: "api_error",
      code: "internal",
      message: `HTTP ${res.status}`,
      request_id: res.headers.get("x-request-id") ?? "01unknownxxxxxxxxxxxxxxx",
    });
  }

  if (isEnvelope<T>(parsed)) {
    return parsed.data;
  }
  return parsed as T;
};
