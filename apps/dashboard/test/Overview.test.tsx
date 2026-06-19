/**
 * apps/dashboard/test/Overview.test.tsx — redesigned page tests.
 *
 * Cases:
 *  1. EmptyState when no sessions
 *  2. Renders 3 StatCards + DataTable of sessions
 *  3. Clicking a session goal navigates to /timeline?session=…
 *  4. Shows the project name as the h2 in the header
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

describe("OverviewPage (6.8.2.P4)", () => {
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
      if (String(url).endsWith("/projects")) {
        return Promise.resolve(jsonResponse({ projects: [{ id: "01p", name: "demo" }] }));
      }
      if (String(url).endsWith("/sessions")) {
        return Promise.resolve(jsonResponse({ sessions: [] }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    renderOverview();

    expect(await screen.findByTestId("overview-page")).toBeInTheDocument();
    expect(
      await screen.findByText(/no sessions yet/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("overview-stats")).toBeInTheDocument();
  });

  it("renders 3 StatCards + DataTable of sessions", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/projects")) {
        return Promise.resolve(jsonResponse({ projects: [{ id: "01p", name: "alpha" }] }));
      }
      if (String(url).endsWith("/sessions")) {
        return Promise.resolve(
          jsonResponse({
            sessions: [
              { id: "01s-a", project_id: "01p", goal: "first", status: "active", created_at: "2026-06-17T10:00:00.000Z" },
              { id: "01s-b", project_id: "01p", goal: "second", status: "paused", created_at: "2026-06-17T11:00:00.000Z" },
              { id: "01s-c", project_id: "01p", goal: "third", status: "closed", created_at: "2026-06-17T12:00:00.000Z" },
            ],
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    renderOverview();

    expect(await screen.findByTestId("overview-page")).toBeInTheDocument();
    const stats = await screen.findByTestId("overview-stats");
    expect(stats).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Events this week")).toBeInTheDocument();
    expect(screen.getByText("Open Decisions")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
  });

  it("clicking a session goal navigates to /timeline?session=…", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/projects")) {
        return Promise.resolve(jsonResponse({ projects: [{ id: "01p", name: "alpha" }] }));
      }
      if (String(url).endsWith("/sessions")) {
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

    const goal = await screen.findByTestId("overview-session-goal");
    await user.click(goal);

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith("/timeline?session=01s-a"),
    );
  });

  it("shows the project name as the h2 in the header", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/projects")) {
        return Promise.resolve(
          jsonResponse({ projects: [{ id: "01p", name: "cognit-demo" }] }),
        );
      }
      if (String(url).endsWith("/sessions")) {
        return Promise.resolve(jsonResponse({ sessions: [] }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    renderOverview();

    const h2 = await screen.findByTestId("overview-project-name");
    expect(h2).toHaveTextContent("cognit-demo");
  });
});
