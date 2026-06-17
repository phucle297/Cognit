/**
 * apps/dashboard/test/KnowledgeGraph.test.tsx
 *
 * Knowledge Graph page tests (4 cases per AC):
 *  1. nodes + edges render after the graph fetch resolves
 *  2. physics toggle starts the force simulation
 *  3. constellation toggle stops the simulation
 *  4. clicking a node opens the side panel with the node label
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { KnowledgeGraphPage } from "../src/pages/knowledge-graph";
import type { GraphResp } from "../src/components/GraphCanvas";

/* -------------------------------------------------------------------------- */
/* Mocks                                                                      */
/* -------------------------------------------------------------------------- */

// Mock xyflow so we don't pull the heavy real component into jsdom.
// We render the `nodes` and `edges` arrays as <div> markers so
// the test surface (data-testid="graph-node" / "graph-edge")
// remains stable without depending on xyflow internals.
vi.mock("@xyflow/react", () => {
  const React = require("react") as typeof import("react");

  type XYNode = {
    id: string;
    position?: { x: number; y: number };
    data?: unknown;
    className?: string;
    "data-testid"?: string;
    onClick?: unknown;
  };
  type XYEdge = {
    id: string;
    source: string;
    target: string;
    style?: React.CSSProperties;
    "data-testid"?: string;
  };

  // Bare stub — render a marker div, never forward children.
  // React 19 + jsdom is finicky about forwarding arbitrary
  // children through mock factories, so the safest behaviour
  // is to ignore them.
  const stub = (id: string): React.FC<{ children?: React.ReactNode }> => {
    const C = (): React.ReactElement => React.createElement("div", { "data-testid": id });
    C.displayName = id;
    return C;
  };

  const ReactFlowMock: React.FC<{
    nodes?: XYNode[];
    edges?: XYEdge[];
    children?: React.ReactNode;
    onNodeClick?: (event: React.MouseEvent, node: XYNode) => void;
  }> = ({ nodes = [], edges = [], onNodeClick }) =>
    React.createElement(
      "div",
      { "data-testid": "react-flow" },
      nodes.map((n) =>
        React.createElement("div", {
          key: n.id,
          "data-testid": n["data-testid"] ?? "graph-node",
          "data-node-id": n.id,
          className: n.className,
          onClick: (e: React.MouseEvent): void => {
            if (onNodeClick) onNodeClick(e, n);
          },
        }),
      ),
      edges.map((e) =>
        React.createElement("div", {
          key: e.id,
          "data-testid": e["data-testid"] ?? "graph-edge",
          "data-edge-id": e.id,
        }),
      ),
    );

  const passthrough: React.FC<{ children?: React.ReactNode }> = ({ children }) =>
    React.createElement(React.Fragment, null, children);

  return {
    ReactFlow: ReactFlowMock,
    ReactFlowProvider: passthrough,
    Background: stub("background"),
    Controls: stub("controls"),
    useNodesState: <T,>(initial: T[]) => {
      const [nodes, setNodes] = React.useState<T[]>(initial);
      const onChange = (): void => {};
      return [nodes, setNodes, onChange] as const;
    },
    useEdgesState: <T,>(initial: T[]) => {
      const [edges, setEdges] = React.useState<T[]>(initial);
      const onChange = (): void => {};
      return [edges, setEdges, onChange] as const;
    },
  };
});

// Mock the force-simulation module so we can assert .restart() / .stop()
// were called. The shape mirrors what GraphCanvas expects.
// vi.mock factories are hoisted above all imports, so the
// mock state must live in `vi.hoisted`.
const simMocks = vi.hoisted(() => {
  const restart = vi.fn();
  const stop = vi.fn();
  const tick = vi.fn();
  const charge = vi.fn();
  const link = vi.fn();
  const center = vi.fn();
  const fakeSim = {
    nodes: (): unknown[] => [],
    force: vi.fn(function force(this: unknown) {
      return this;
    }),
    alpha: vi.fn(function alpha(this: unknown) {
      return 1;
    }),
    alphaMin: vi.fn(function alphaMin(this: unknown) {
      return 0.001;
    }),
    alphaDecay: vi.fn(function alphaDecay(this: unknown) {
      return 0.01;
    }),
    velocityDecay: vi.fn(function velocityDecay(this: unknown) {
      return 0.4;
    }),
    restart,
    stop,
    tick,
    on: vi.fn(function on(this: unknown) {
      return this;
    }),
  };
  const forceSimulation = vi.fn(() => fakeSim);
  const forceManyBody = vi.fn(() => charge);
  const forceLink = vi.fn(() => link);
  const forceCenter = vi.fn(() => center);
  return {
    restart,
    stop,
    tick,
    charge,
    link,
    center,
    fakeSim,
    forceSimulation,
    forceManyBody,
    forceLink,
    forceCenter,
  };
});

vi.mock("@/lib/force-simulation", () => ({
  forceSimulation: simMocks.forceSimulation,
  forceManyBody: simMocks.forceManyBody,
  forceLink: simMocks.forceLink,
  forceCenter: simMocks.forceCenter,
}));

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const sampleGraph: GraphResp = {
  session_id: "01TEST",
  nodes: [
    { id: "hypothesis:01H1", entity_type: "hypothesis", entity_id: "01H1", label: "Hypothesis alpha" },
    { id: "decision:01D1", entity_type: "decision", entity_id: "01D1", label: "Decision beta" },
    { id: "conclusion:01C1", entity_type: "conclusion", entity_id: "01C1", label: "Conclusion gamma" },
  ],
  edges: [
    {
      id: "e1",
      edge_type: "supports",
      from: "hypothesis:01H1",
      to: "conclusion:01C1",
      from_entity_type: "hypothesis",
      from_entity_id: "01H1",
      to_entity_type: "conclusion",
      to_entity_id: "01C1",
      virtual: false,
    },
    {
      id: "e2",
      edge_type: "informs",
      from: "decision:01D1",
      to: "hypothesis:01H1",
      from_entity_type: "decision",
      from_entity_id: "01D1",
      to_entity_type: "hypothesis",
      to_entity_id: "01H1",
      virtual: false,
    },
  ],
};

const mockFetchOk = (data: unknown): ReturnType<typeof vi.fn> =>
  vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ version: 1, kind: "session.graph", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const renderKG = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter initialEntries={["/knowledge-graph?session=01TEST"]}>
      <KnowledgeGraphPage />
    </MemoryRouter>,
  );

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("KnowledgeGraphPage", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    simMocks.restart.mockClear();
    simMocks.stop.mockClear();
    simMocks.tick.mockClear();
    simMocks.forceSimulation.mockClear();
    simMocks.forceManyBody.mockClear();
    simMocks.forceLink.mockClear();
    simMocks.forceCenter.mockClear();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders nodes and edges from /sessions/:id/graph", async () => {
    globalThis.fetch = mockFetchOk(sampleGraph) as unknown as typeof fetch;
    renderKG();

    // The canvas wrapper is rendered once the fetch resolves.
    await waitFor(() => expect(screen.getByTestId("graph-canvas")).toBeInTheDocument());

    // 3 graph-node elements should appear.
    const nodeEls = await screen.findAllByTestId("graph-node");
    expect(nodeEls).toHaveLength(3);

    // 2 graph-edge elements.
    const edgeEls = screen.getAllByTestId("graph-edge");
    expect(edgeEls).toHaveLength(2);
  });

  it("physics toggle creates and restarts a force simulation", async () => {
    // Auto-constellation kicks in only when > 200 nodes; with 3
    // nodes the default mode is physics and the simulation is
    // created on first render. To assert the *toggle* path we
    // start in constellation and switch to physics.
    globalThis.fetch = mockFetchOk(sampleGraph) as unknown as typeof fetch;
    renderKG();

    await waitFor(() => expect(screen.getByTestId("graph-controls")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("layout-constellation"));
    // constellation path: simulation was not started (or was
    // stopped). Clear and re-init by switching to physics.
    simMocks.forceSimulation.mockClear();
    simMocks.restart.mockClear();

    await user.click(screen.getByTestId("layout-physics"));

    await waitFor(() => {
      expect(simMocks.forceSimulation).toHaveBeenCalled();
      expect(simMocks.restart).toHaveBeenCalled();
    });
    // The simulation should have been wired with three forces.
    const calls = (simMocks.fakeSim.force as unknown as { mock: { calls: unknown[] } }).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("constellation toggle stops the simulation", async () => {
    globalThis.fetch = mockFetchOk(sampleGraph) as unknown as typeof fetch;
    renderKG();

    await waitFor(() => expect(screen.getByTestId("graph-controls")).toBeInTheDocument());

    // Force auto-constellation mode by going constellation first
    // (or rely on default: 3 nodes => physics). Either way,
    // switching to constellation must call .stop() at least once.
    const user = userEvent.setup();
    simMocks.stop.mockClear();
    await user.click(screen.getByTestId("layout-constellation"));

    await waitFor(() => expect(simMocks.stop).toHaveBeenCalled());
  });

  it("clicking a node opens the side panel with the node label", async () => {
    globalThis.fetch = mockFetchOk(sampleGraph) as unknown as typeof fetch;
    renderKG();

    const nodes = await screen.findAllByTestId("graph-node");
    expect(nodes.length).toBeGreaterThan(0);
    const user = userEvent.setup();
    await user.click(nodes[0]!);

    const panel = await screen.findByTestId("node-side-panel");
    expect(panel).toBeInTheDocument();
    // The label rendered inside the panel should match one of
    // our sample labels.
    expect(panel.textContent).toMatch(/Hypothesis alpha|Decision beta|Conclusion gamma/);
    // data-testid exposes the label explicitly.
    expect(screen.getByTestId("node-side-panel-label").textContent).toMatch(
      /Hypothesis alpha|Decision beta|Conclusion gamma/,
    );
  });
});
