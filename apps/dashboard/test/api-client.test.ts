/**
 * apps/dashboard/test/api-client.test.ts
 *
 * Tests the FSD shared/api layer by importing from the
 * AC-required path (src/lib/api-client.ts). Cases:
 *  1. URL prefix (relative → resolved)
 *  2. credentials: "include" sent
 *  3. success envelope unwrapped
 *  4. api_error thrown with code+message+request_id
 *  5. network error throws with request_id
 *  6. AbortSignal respected
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { apiFetch, ApiError } from "@/lib/api-client";

describe("apiFetch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves a relative path against the current origin", async () => {
    const spy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: 1, kind: "health", data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    const data = await apiFetch<{ ok: boolean }>("/health");
    expect(data).toEqual({ ok: true });
    const calledWith = spy.mock.calls[0]?.[0] as string;
    expect(calledWith).toBe("/health");
  });

  it("sends credentials: include and default headers", async () => {
    const spy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: 1, kind: "x", data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiFetch("/sessions", { method: "GET" });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("include");
    const headers = init.headers as Record<string, string>;
    expect(headers["accept"]).toBe("application/json");
  });

  it("unwraps the v1 success envelope", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: 1, kind: "list_sessions", data: [{ id: "01ABC" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const data = await apiFetch<Array<{ id: string }>>("/sessions");
    expect(Array.isArray(data)).toBe(true);
    expect(data[0]?.id).toBe("01ABC");
  });

  it("throws ApiError with code+message+request_id on api_error envelope", async () => {
    const makeBody = (): string =>
      JSON.stringify({
        kind: "api_error",
        code: "not_found",
        message: "session missing",
        request_id: "01REQIDABCDEFGHJ",
      });
    globalThis.fetch = vi.fn().mockImplementation(
      () =>
        Promise.resolve(
          new Response(makeBody(), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        ),
    ) as unknown as typeof fetch;
    try {
      await apiFetch("/sessions/01nope");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).api.code).toBe("not_found");
      expect((err as ApiError).api.message).toBe("session missing");
      expect((err as ApiError).api.request_id).toBe("01REQIDABCDEFGHJ");
    }
  });

  it("throws an ApiError with a request_id on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;
    try {
      await apiFetch("/sessions");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).api.request_id).toMatch(/^01/);
      expect((err as ApiError).api.code).toBe("internal");
    }
  });

  it("respects an AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();
    const spy = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(
      apiFetch("/sessions", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ApiError);
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });
});
