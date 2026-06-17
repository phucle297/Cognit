/**
 * apps/dashboard/test/DecisionGraph.test.tsx
 *
 * FSD: tests the pages/decision-graph page by importing from the
 * AC-required path (src/pages/decision-graph.tsx). Cases:
 *  1. accepted + rejected render
 *  2. based_on link — both source labels are shown
 *  3. superseded chain — chain is rendered as a linked trail
 *
 * Strategy: mock `globalThis.fetch` so each call returns the right
 * envelope (state + edges), wrap with MemoryRouter, drive search
 * params via a stub `?session=…`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { DecisionGraphPage } from "@/pages/decision-graph";

const envelope = (kind: string, data: unknown): string =>
  JSON.stringify({ version: 1, kind, data });

type DecisionWire = {
  id: string;
  text: string;
  state: "proposed" | "accepted" | "rejected" | "superseded";
  based_on_conclusion_ids: string[];
  superseded_by_decision_id: string | null;
  created_at: string;
};

type EdgeWire = {
  id: string;
  edge_type: string;
  from_entity_type: string;
  from_entity_id: string;
  to_entity_type: string;
  to_entity_id: string;
};

const buildStateResp = (decisions: DecisionWire[]): unknown => ({
  session: { id: "01SESSION" },
  state: {
    decisions: Object.fromEntries(decisions.map((d) => [d.id, d])),
    conclusions: {
      "01C1": { id: "01C1", text: "cache miss under load", state: "verified" },
      "01C2": { id: "01C2", text: "query plan is N+1", state: "verified" },
    },
    experiments: {},
  },
});

const buildEdgesResp = (edges: EdgeWire[]): unknown => ({ edges, next_cursor: null });

const renderDecisionGraph = (sessionId: string): ReturnType<typeof render> =>
  render(
    <MemoryRouter initialEntries={[`/decision-graph?session=${sessionId}`]}>
      <Routes>
        <Route path="/decision-graph" element={<DecisionGraphPage />} />
      </Routes>
    </MemoryRouter>,
  );

const findRowByDecisionId = (id: string): HTMLElement => {
  const rows = screen.getAllByTestId("decision-row");
  const found = rows.find((r) => r.getAttribute("data-decision-id") === id);
  if (!found) throw new Error(`no decision row for id ${id}`);
  return found;
};

describe("DecisionGraphPage", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders accepted and rejected decisions", async () => {
    const decisions: DecisionWire[] = [
      {
        id: "01D-ACCEPTED",
        text: "Add LRU cache for hot keys",
        state: "accepted",
        based_on_conclusion_ids: [],
        superseded_by_decision_id: null,
        created_at: "2026-06-17T00:00:00Z",
      },
      {
        id: "01D-REJECTED",
        text: "Rewrite the entire module",
        state: "rejected",
        based_on_conclusion_ids: [],
        superseded_by_decision_id: null,
        created_at: "2026-06-17T00:00:01Z",
      },
    ];

    const spy = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/sessions/01SESSION/state")) {
        return Promise.resolve(
          new Response(envelope("session.state", buildStateResp(decisions)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.startsWith("/sessions/01SESSION/edges")) {
        return Promise.resolve(
          new Response(envelope("session.edges", buildEdgesResp([])), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    renderDecisionGraph("01SESSION");

    const accepted = await screen.findByTestId("decision-accepted");
    const rejected = await screen.findByTestId("decision-rejected");
    expect(within(accepted).getByText(/Add LRU cache for hot keys/i)).toBeInTheDocument();
    expect(within(rejected).getByText(/Rewrite the entire module/i)).toBeInTheDocument();
    expect(spy).toHaveBeenCalled();
  });

  it("shows based_on source labels for each edge", async () => {
    const decisions: DecisionWire[] = [
      {
        id: "01D-ACCEPTED",
        text: "Add LRU cache for hot keys",
        state: "accepted",
        based_on_conclusion_ids: ["01C1", "01C2"],
        superseded_by_decision_id: null,
        created_at: "2026-06-17T00:00:00Z",
      },
    ];
    const edges: EdgeWire[] = [
      {
        id: "01E1",
        edge_type: "based_on",
        from_entity_type: "conclusion",
        from_entity_id: "01C1",
        to_entity_type: "decision",
        to_entity_id: "01D-ACCEPTED",
      },
      {
        id: "01E2",
        edge_type: "based_on",
        from_entity_type: "conclusion",
        from_entity_id: "01C2",
        to_entity_type: "decision",
        to_entity_id: "01D-ACCEPTED",
      },
    ];

    const spy = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/sessions/01SESSION/state")) {
        return Promise.resolve(
          new Response(envelope("session.state", buildStateResp(decisions)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.startsWith("/sessions/01SESSION/edges")) {
        return Promise.resolve(
          new Response(envelope("session.edges", buildEdgesResp(edges)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    renderDecisionGraph("01SESSION");

    const accepted = await screen.findByTestId("decision-accepted");
    const basedOn = within(accepted).getByTestId("decision-based-on");
    expect(within(basedOn).getByText(/cache miss under load/i)).toBeInTheDocument();
    expect(within(basedOn).getByText(/query plan is N\+1/i)).toBeInTheDocument();
  });

  it("renders the superseded chain as a clickable trail", async () => {
    const decisions: DecisionWire[] = [
      {
        id: "01D-A",
        text: "Use a sliding window",
        state: "superseded",
        based_on_conclusion_ids: [],
        superseded_by_decision_id: "01D-B",
        created_at: "2026-06-17T00:00:00Z",
      },
      {
        id: "01D-B",
        text: "Use a fixed window",
        state: "superseded",
        based_on_conclusion_ids: [],
        superseded_by_decision_id: "01D-C",
        created_at: "2026-06-17T00:00:01Z",
      },
      {
        id: "01D-C",
        text: "Use a token bucket",
        state: "accepted",
        based_on_conclusion_ids: [],
        superseded_by_decision_id: null,
        created_at: "2026-06-17T00:00:02Z",
      },
    ];

    const spy = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/sessions/01SESSION/state")) {
        return Promise.resolve(
          new Response(envelope("session.state", buildStateResp(decisions)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.startsWith("/sessions/01SESSION/edges")) {
        return Promise.resolve(
          new Response(envelope("session.edges", buildEdgesResp([])), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    renderDecisionGraph("01SESSION");

    // Wait for all three rows to land.
    await waitFor(() => {
      const rows = screen.getAllByTestId("decision-row");
      expect(rows).toHaveLength(3);
    });
    // A links to B; B links to C; C is terminal in the chain.
    const rowA = findRowByDecisionId("01D-A");
    const chainA = within(rowA).getByTestId("decision-superseded-chain");
    const linkA = within(chainA).getByRole("link", { name: /fixed window/i });
    expect(linkA.getAttribute("href")).toBe("#decision-01D-B");

    const rowB = findRowByDecisionId("01D-B");
    const chainB = within(rowB).getByTestId("decision-superseded-chain");
    const linkB = within(chainB).getByRole("link", { name: /token bucket/i });
    expect(linkB.getAttribute("href")).toBe("#decision-01D-C");

    const rowC = findRowByDecisionId("01D-C");
    expect(within(rowC).queryByTestId("decision-superseded-chain")).toBeNull();
  });
});