/**
 * apps/dashboard/test/Overview.test.tsx — home for current Cognit root.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { OverviewPage } from "@/pages/overview";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: (): typeof mockNavigate => mockNavigate };
});

const renderOverview = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>,
  );

const envelope = (data: unknown): string =>
  JSON.stringify({ version: 1, kind: "test", data });

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(envelope(data), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("OverviewPage", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    mockNavigate.mockReset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders EmptyState when no sessions", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/sessions")) {
        return Promise.resolve(jsonResponse({ sessions: [] }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    renderOverview();
    expect(await screen.findByTestId("overview-page")).toBeInTheDocument();
    expect(await screen.findByText(/no sessions yet/i)).toBeInTheDocument();
  });

  it("renders sessions table + real stats (no project UI)", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/sessions")) {
        return Promise.resolve(
          jsonResponse({
            sessions: [
              { id: "01s-a", project_id: "01p", goal: "first", status: "active", created_at: "2026-06-17T10:00:00.000Z" },
              { id: "01s-b", project_id: "01p", goal: "second", status: "paused", created_at: "2026-06-17T11:00:00.000Z" },
            ],
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    renderOverview();
    expect(await screen.findByTestId("overview-page")).toBeInTheDocument();
    const stats = await screen.findByTestId("overview-stats");
    expect(within(stats).getByText("Sessions")).toBeInTheDocument();
    expect(within(stats).getByText("Active")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-project-name")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overview-project-select")).not.toBeInTheDocument();
    expect(screen.queryByText("New project")).not.toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
  });

  it("clicking a session goal navigates to timeline", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/sessions")) {
        return Promise.resolve(
          jsonResponse({
            sessions: [
              { id: "01s-a", project_id: "01p", goal: "first", status: "active", created_at: "2026-06-17T10:00:00.000Z" },
            ],
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByTestId("overview-session-goal"));
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith("/timeline?session=01s-a"),
    );
  });

  it("New session opens session dialog", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/sessions")) {
        return Promise.resolve(jsonResponse({ sessions: [] }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByTestId("overview-new-session"));
    expect(await screen.findByTestId("new-session-goal-input")).toBeInTheDocument();
  });
});
