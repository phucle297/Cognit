/**
 * apps/dashboard/test/Login.test.tsx
 *
 * FSD: tests the features/auth login page by importing from the
 * AC-required path (src/pages/Login.tsx). Cases:
 *  1. renders the form
 *  2. submit POSTs to /auth/login
 *  3. on 204, navigates to /
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { LoginPage } from "@/pages/Login";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: (): typeof mockNavigate => mockNavigate,
  };
});

const renderLogin = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );

describe("LoginPage", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    mockNavigate.mockReset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the login form", () => {
    renderLogin();
    expect(screen.getByLabelText(/api token/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("POSTs { token } to /auth/login on submit", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    renderLogin();
    const input = screen.getByLabelText(/api token/i) as HTMLInputElement;
    await userEvent.type(input, "supersecrettoken");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/auth/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ token: "supersecrettoken" });
  });

  it("navigates to / on 204", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    renderLogin();
    const input = screen.getByLabelText(/api token/i) as HTMLInputElement;
    await userEvent.type(input, "supersecrettoken");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));
  });
});
