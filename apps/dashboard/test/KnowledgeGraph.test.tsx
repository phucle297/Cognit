/**
 * apps/dashboard/test/KnowledgeGraph.test.tsx — redesigned page tests.
 *
 * Cases:
 *  1. Renders full-bleed node count
 *  2. EmptyState when graph has 0 nodes
 *  3. Sidebar auto-collapses on mount
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SidebarProvider } from "@/widgets/sidebar/sidebar-provider";
import { KnowledgeGraphPage } from "@/pages/knowledge-graph";
import type { GraphResp } from "@/components/GraphCanvas";

const envelope = (data: unknown): string =>
  JSON.stringify({ version: 1, kind: "test", data });

const sampleGraph: GraphResp = {
  session_id: "01TEST",
  nodes: [
    { id: "hypothesis:01H1", entity_type: "hypothesis", entity_id: "01H1", label: "alpha" },
    { id: "decision:01D1", entity_type: "decision", entity_id: "01D1", label: "beta" },
  ],
  edges: [],
};

const renderKG = (sessionId: string): ReturnType<typeof render> =>
  render(
    <MemoryRouter initialEntries={[`/knowledge-graph?session=${sessionId}`]}>
      <SidebarProvider>
        <Routes>
          <Route path="/knowledge-graph" element={<KnowledgeGraphPage />} />
        </Routes>
      </SidebarProvider>
    </MemoryRouter>,
  );

const readCollapsed = (): string | null => window.localStorage.getItem("cognit.sidebar.collapsed");

describe("KnowledgeGraphPage (6.8.2.P4)", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  const mockGraphFetch = (graph: GraphResp = sampleGraph): void => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/graph")) {
        return Promise.resolve(new Response(envelope(graph), { status: 200 }));
      }
      if (u.includes("/events")) {
        return Promise.resolve(new Response(envelope({ events: [] }), { status: 200 }));
      }
      if (u.endsWith("/api/sessions") || u.includes("/api/sessions?")) {
        return Promise.resolve(
          new Response(
            envelope({
              sessions: [{ id: "01TEST", goal: "test", status: "active" }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;
  };

  it("renders full-bleed node count", async () => {
    mockGraphFetch();
    renderKG("01TEST");
    const count = await screen.findByTestId("kg-node-count");
    expect(count).toHaveTextContent("2 nodes");
  });

  it("shows session selector when no session", async () => {
    mockGraphFetch();
    render(
      <MemoryRouter initialEntries={["/knowledge-graph"]}>
        <SidebarProvider>
          <Routes>
            <Route path="/knowledge-graph" element={<KnowledgeGraphPage />} />
          </Routes>
        </SidebarProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("kg-session-select")).toBeInTheDocument();
    expect(screen.getByText(/No session selected/i)).toBeInTheDocument();
  });

  it("EmptyState when graph has 0 nodes", async () => {
    const empty: GraphResp = { session_id: "01TEST", nodes: [], edges: [] };
    mockGraphFetch(empty);
    renderKG("01TEST");
    expect(await screen.findByTestId("kg-empty")).toBeInTheDocument();
  });

  it("does NOT auto-collapse sidebar on mount (user toggles manually)", async () => {
    mockGraphFetch();
    renderKG("01TEST");
    await screen.findByTestId("kg-node-count");
    await waitFor(() => {
      // Sidebar stays expanded by default — localStorage flag must
      // remain "0" after the page mounts. Previously this route
      // called setCollapsed(true) on mount, which auto-collapsed
      // the sidebar every time the user opened the graph view.
      expect(readCollapsed()).toBe("0");
    });
  });
});
