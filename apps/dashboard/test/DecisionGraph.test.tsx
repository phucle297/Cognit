/**
 * apps/dashboard/test/DecisionGraph.test.tsx — redesigned page tests.
 *
 * Cases:
 *  1. Renders full-bleed decision count
 *  2. EmptyState when 0 decisions
 *  3. Sidebar auto-collapses on mount
 *  4. DataTable of decisions renders rows
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SidebarProvider } from "@/widgets/sidebar/sidebar-provider";
import { DecisionGraphPage } from "@/pages/decision-graph";

const envelope = (data: unknown): string =>
  JSON.stringify({ version: 1, kind: "test", data });

const stateResp = (decisions: Array<Record<string, unknown>>): unknown => ({
  session: { id: "01SESSION" },
  state: { decisions: Object.fromEntries(decisions.map((d) => [d.id, d])) },
});

const graphResp = (nodes: number): unknown => ({
  session_id: "01SESSION",
  nodes: Array.from({ length: nodes }, (_, i) => ({
    id: `decision:${i}`,
    entity_type: "decision",
    entity_id: String(i),
    label: `Decision ${i}`,
  })),
  edges: [],
});

const renderDG = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter initialEntries={["/decision-graph?session=01SESSION"]}>
      <SidebarProvider>
        <Routes>
          <Route path="/decision-graph" element={<DecisionGraphPage />} />
        </Routes>
      </SidebarProvider>
    </MemoryRouter>,
  );

const readCollapsed = (): string | null => window.localStorage.getItem("cognit.sidebar.collapsed");

describe("DecisionGraphPage (6.8.2.P4)", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders full-bleed decision count", async () => {
    const decisions = [
      { id: "01D1", text: "add LRU", state: "accepted", based_on_conclusion_ids: [], superseded_by_decision_id: null, created_at: "2026-06-17T00:00:00Z" },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/state")) {
        return Promise.resolve(new Response(envelope(stateResp(decisions)), { status: 200 }));
      }
      if (String(url).includes("/graph")) {
        return Promise.resolve(new Response(envelope(graphResp(1)), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderDG();
    const count = await screen.findByTestId("decision-count");
    expect(count).toHaveTextContent("1 decision");
  });

  it("EmptyState when 0 decisions", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/state")) {
        return Promise.resolve(new Response(envelope(stateResp([])), { status: 200 }));
      }
      if (String(url).includes("/graph")) {
        return Promise.resolve(new Response(envelope(graphResp(0)), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderDG();
    expect(await screen.findByTestId("decision-empty")).toBeInTheDocument();
  });

  it("does NOT auto-collapse sidebar on mount (user toggles manually)", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/state")) {
        return Promise.resolve(new Response(envelope(stateResp([])), { status: 200 }));
      }
      if (String(url).includes("/graph")) {
        return Promise.resolve(new Response(envelope(graphResp(0)), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderDG();
    await screen.findByTestId("decision-count");
    await waitFor(() => {
      // Sidebar stays expanded by default — localStorage flag must
      // remain "0" after the page mounts. Previously this route
      // called setCollapsed(true) on mount, which auto-collapsed
      // the sidebar every time the user opened the decision graph.
      expect(readCollapsed()).toBe("0");
    });
  });

  it("DataTable of decisions renders rows", async () => {
    const decisions = [
      { id: "01D1", text: "add LRU", state: "accepted", based_on_conclusion_ids: [], superseded_by_decision_id: null, created_at: "2026-06-17T00:00:00Z" },
      { id: "01D2", text: "rewrite", state: "rejected", based_on_conclusion_ids: [], superseded_by_decision_id: null, created_at: "2026-06-17T00:00:01Z" },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/state")) {
        return Promise.resolve(new Response(envelope(stateResp(decisions)), { status: 200 }));
      }
      if (String(url).includes("/graph")) {
        return Promise.resolve(new Response(envelope(graphResp(2)), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderDG();
    expect(await screen.findByText("add LRU")).toBeInTheDocument();
    expect(await screen.findByText("rewrite")).toBeInTheDocument();
  });
});
