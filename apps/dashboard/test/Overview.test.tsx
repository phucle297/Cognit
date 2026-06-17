/**
 * apps/dashboard/test/Overview.test.tsx
 *
 * FSD: tests the pages/overview page by importing from the
 * AC-required path (src/pages/overview.tsx). Cases:
 *  1. empty state when /projects returns { projects: [] }
 *  2. renders 3 ProjectCard elements when /projects returns 3
 *  3. clicking a ProjectCard calls useNavigate with /timeline?session=<first>
 *  4. opening dialog, typing a name, clicking submit POSTs
 *     { name, goal? } to /projects
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { OverviewPage } from "@/pages/overview";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: (): typeof mockNavigate => mockNavigate,
  };
});

const renderOverview = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <OverviewPage />
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

const emptyProjectsResp = { projects: [] };

const threeProjectsResp = {
  projects: [
    { id: "01proj1", name: "alpha" },
    { id: "01proj2", name: "beta", goal: "study cognition loops" },
    { id: "01proj3", name: "gamma" },
  ],
};

const sessionsResp = {
  sessions: [
    {
      id: "01sess-a",
      project_id: "01proj1",
      goal: "first session for alpha",
      status: "active",
      created_at: "2026-06-17T10:00:00.000Z",
    },
    {
      id: "01sess-b",
      project_id: "01proj1",
      goal: "second session for alpha",
      status: "closed",
      created_at: "2026-06-17T11:00:00.000Z",
    },
    {
      id: "01sess-c",
      project_id: "01proj2",
      goal: "beta session",
      status: "paused",
      created_at: "2026-06-17T12:00:00.000Z",
    },
  ],
};

describe("OverviewPage", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    mockNavigate.mockReset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the empty state when /projects returns no projects", async () => {
    const spy = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/projects")) {
        return Promise.resolve(jsonResponse(emptyProjectsResp));
      }
      if (String(url).endsWith("/sessions")) {
        return Promise.resolve(jsonResponse({ sessions: [] }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    renderOverview();

    expect(
      await screen.findByText(/no projects yet/i),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/create your first project/i),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId("project-card")).toHaveLength(0);
  });

  it("renders one ProjectCard per project when /projects returns 3", async () => {
    const spy = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/projects")) {
        return Promise.resolve(jsonResponse(threeProjectsResp));
      }
      if (String(url).endsWith("/sessions")) {
        return Promise.resolve(jsonResponse(sessionsResp));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    renderOverview();

    const cards = await screen.findAllByTestId("project-card");
    expect(cards).toHaveLength(3);
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("gamma")).toBeInTheDocument();
  });

  it("clicking a ProjectCard navigates to /timeline?session=<first-session-id>", async () => {
    const spy = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/projects")) {
        return Promise.resolve(jsonResponse(threeProjectsResp));
      }
      if (String(url).endsWith("/sessions")) {
        return Promise.resolve(jsonResponse(sessionsResp));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    const user = userEvent.setup();
    renderOverview();

    const cards = await screen.findAllByTestId("project-card");
    // alpha's most recent session (newest created_at) is "01sess-b".
    const alphaCard = cards.find((c) => c.getAttribute("data-project-id") === "01proj1")!;
    await user.click(alphaCard);

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith("/timeline?session=01sess-b"),
    );
  });

  it("submitting the New project dialog POSTs { name, goal? } to /projects", async () => {
    const spy = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/projects") && (init?.method ?? "GET") === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              version: 1,
              kind: "project.created",
              data: { project: { id: "01proj-new", name: "delta" } },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (u.endsWith("/projects")) {
        return Promise.resolve(jsonResponse(threeProjectsResp));
      }
      if (u.endsWith("/sessions")) {
        return Promise.resolve(jsonResponse(sessionsResp));
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    const user = userEvent.setup();
    renderOverview();

    // Open the dialog via the header button (use the heading to
    // disambiguate from the empty-state button, which isn't shown
    // here because we have 3 projects).
    await user.click(screen.getByRole("button", { name: /new project/i }));

    const nameInput = await screen.findByLabelText(/^name$/i);
    const goalInput = screen.getByLabelText(/^goal/i);
    await user.type(nameInput, "delta");
    await user.type(goalInput, "explore deltas");

    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => {
      const postCall = spy.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith("/projects") && ((init as RequestInit | undefined)?.method ?? "GET") === "POST",
      );
      expect(postCall).toBeDefined();
    });
    const [, init] = spy.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/projects") && ((init as RequestInit | undefined)?.method ?? "GET") === "POST",
    ) as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe("delta");
    expect(body.goal).toBe("explore deltas");
  });
});
