/**
 * apps/dashboard/test/Settings.test.tsx
 *
 * FSD: tests the pages/settings page by importing from the
 * AC-required path (src/pages/settings.tsx). Cases:
 *  1. Config tab renders masked api_token (shows "****")
 *  2. Storage tab renders sessions count "1" and events count "0"
 *     when /sessions returns 1 session and /events returns empty
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "@/pages/settings";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: (): typeof mockNavigate => mockNavigate,
  };
});

const renderSettings = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );

/**
 * The api-client unwraps the v1 envelope and returns the inner
 * `data` field. Tests mock globalThis.fetch with Response bodies
 * that match that envelope shape.
 */
const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ version: 1, kind: "test", data }), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("SettingsPage", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    mockNavigate.mockReset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the Config tab with a masked api_token showing ****", async () => {
    // Config tab does not fetch anything in v0.1 — placeholder
    // SAFE-PREVIEW object is hard-coded inside the component.
    const spy = vi.fn().mockImplementation(() =>
      Promise.reject(new Error("unexpected fetch on Config tab")),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    renderSettings();

    // The Config tab is the default tab; the masked token "****"
    // must be present in the read-only preview.
    expect(await screen.findByText(/\*\*\*\*/)).toBeInTheDocument();
  });

  it("renders the Storage tab with sessions count 1 and events count 0", async () => {
    const oneSessionResp = {
      sessions: [
        {
          id: "01sess-x",
          project_id: "01proj-x",
          goal: "lonely session",
          status: "active",
          created_at: "2026-06-17T10:00:00.000Z",
        },
      ],
    };
    const emptyEventsResp = { events: [] };

    const spy = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/sessions") && !u.includes("/recovery")) {
        return Promise.resolve(jsonResponse(oneSessionResp));
      }
      if (u.includes("/events")) {
        return Promise.resolve(jsonResponse(emptyEventsResp));
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("tab", { name: /storage/i }));

    // Wait for the fetch round-trip: /sessions then /events?session_id=<id>.
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });

    // Sessions count: 1, Events count: 0. Use data-testids to
    // disambiguate from the artifacts card which also renders a 0.
    expect(await screen.findByTestId("sessions-count")).toHaveTextContent("1");
    expect(await screen.findByTestId("events-count")).toHaveTextContent("0");
  });
});