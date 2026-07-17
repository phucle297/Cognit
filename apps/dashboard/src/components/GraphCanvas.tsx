/**
 * apps/dashboard/src/components/GraphCanvas.tsx — xyflow host.
 *
 * Hosts the <ReactFlow> instance for the Knowledge Graph page.
 * Owns the conversion from server-shape `GraphNode`/`GraphEdge`
 * to xyflow `Node`/`Edge`, and runs the physics simulation when
 * the page is in physics mode.
 *
 * The component is deliberately self-contained: it does not
 * know about URL params, controls, or the side panel. Callers
 * pass data + callbacks in via props. That keeps the test
 * surface narrow and matches the AC "4 cases" requirement.
 */
import { useCallback, useEffect, useMemo, useRef, type JSX } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge as XYEdge,
  type Node as XYNode,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimNode,
} from "../lib/force-simulation";
import { edgeStroke, nodeBorder, nodeFill, nodeText } from "../lib/node-colors";

export type GraphNode = {
  readonly id: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly label: string;
};

export type GraphEdge = {
  readonly id: string;
  readonly edge_type: string;
  readonly from: string;
  readonly to: string;
  readonly from_entity_type: string;
  readonly from_entity_id: string;
  readonly to_entity_type: string;
  readonly to_entity_id: string;
  readonly virtual: boolean;
};

export type GraphResp = {
  readonly session_id: string;
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
};

export type LayoutMode = "physics" | "constellation";

export type GraphCanvasProps = {
  readonly data: GraphResp;
  readonly mode: LayoutMode;
  readonly visibleEdgeTypes: ReadonlySet<string>;
  readonly onNodeClick: (node: GraphNode) => void;
  readonly onFitView?: () => void;
};

const NODE_CAP = 500;

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

const constellationPositions = (count: number): Array<{ x: number; y: number }> => {
  // Pick circle for moderate counts, grid for larger sets.
  if (count <= 1) return [{ x: 0, y: 0 }];
  const radius = 80 + Math.sqrt(count) * 24;
  const cx = 0;
  const cy = 0;
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
};

const toXYNodes = (
  graphNodes: GraphNode[],
  positions: Array<{ x: number; y: number }>,
  onClick: NodeMouseHandler,
): XYNode[] =>
  graphNodes.map((n, i) => {
    const p = positions[i] ?? { x: 0, y: 0 };
    return {
      id: n.id,
      type: "default",
      position: { x: p.x, y: p.y },
      data: { label: truncate(n.label, 32) },
      style: {
        background: undefined,
        border: undefined,
        // We render label inside a div via custom class for colour
        // by entity_type. xyflow will use the default node
        // chrome; we style the label and a top border instead.
        padding: 4,
        borderRadius: 6,
      },
      className: `react-flow__node-cognit ${nodeFill(n.entity_type)} ${nodeText(n.entity_type)} ${nodeBorder(n.entity_type)}`,
      onClick,
      'data-testid': "graph-node",
      'data-entity-type': n.entity_type,
      'data-node-id': n.id,
    } as unknown as XYNode;
  });

const toXYEdges = (graphEdges: GraphEdge[], visible: ReadonlySet<string>): XYEdge[] =>
  graphEdges
    .filter((e) => visible.size === 0 || visible.has(e.edge_type))
    .map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.edge_type,
      type: "default",
      style: { stroke: edgeStroke(e.edge_type), strokeWidth: e.virtual ? 1.5 : 2 },
      animated: e.virtual,
      'data-testid': "graph-edge",
    } as unknown as XYEdge));

/**
 * Internal host that lives inside <ReactFlowProvider> so it can
 * use the xyflow state hooks.
 */
const GraphCanvasInner = ({
  data,
  mode,
  visibleEdgeTypes,
  onNodeClick,
}: GraphCanvasProps): JSX.Element => {
  const [nodes, setNodes, onNodesChange] = useNodesState<XYNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<XYEdge>([]);
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const animRef = useRef<number | null>(null);

  // Cap visible nodes.
  const cappedNodes = useMemo(() => data.nodes.slice(0, NODE_CAP), [data.nodes]);
  const cappedEdges = useMemo(
    () => data.edges.filter((e) => cappedNodes.some((n) => n.id === e.from) && cappedNodes.some((n) => n.id === e.to)),
    [data.edges, cappedNodes],
  );

  // Initial positions depend on mode. Constellation is stable;
  // physics seeds with random positions and the simulation
  // mutates them.
  const initialPositions = useMemo(() => {
    if (mode === "constellation") {
      return constellationPositions(cappedNodes.length);
    }
    return cappedNodes.map(() => ({ x: Math.random() * 600 - 300, y: Math.random() * 400 - 200 }));
  }, [cappedNodes, mode]);

  const handleNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      const found = data.nodes.find((n) => n.id === node.id);
      if (found) onNodeClick(found);
    },
    [data.nodes, onNodeClick],
  );

  // Build xyflow nodes/edges from data.
  useEffect(() => {
    setNodes(toXYNodes(cappedNodes, initialPositions, handleNodeClick));
  }, [cappedNodes, initialPositions, handleNodeClick, setNodes]);

  useEffect(() => {
    setEdges(toXYEdges(cappedEdges, visibleEdgeTypes));
  }, [cappedEdges, visibleEdgeTypes, setEdges]);

  // Run / stop the physics simulation in sync with `mode`.
  useEffect(() => {
    // Always tear down any in-flight simulation when the effect
    // re-runs (mode flip, data change).
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
    if (simRef.current) {
      simRef.current.stop();
      simRef.current = null;
    }

    if (mode !== "physics") return;
    if (cappedNodes.length === 0) return;

    const simNodes: SimNode[] = cappedNodes.map((n, i) => ({
      id: n.id,
      x: initialPositions[i]?.x ?? 0,
      y: initialPositions[i]?.y ?? 0,
    }));
    const simLinks = cappedEdges.map((e) => ({ source: e.from, target: e.to }));

    const charge = forceManyBody<SimNode>({ strength: -120 });
    const link = forceLink<SimNode>(simLinks, { distance: 80, strength: 0.4 });
    const center = forceCenter<SimNode>(0, 0, { strength: 0.05 });

    const sim = forceSimulation<SimNode>(simNodes);
    sim.force("charge", charge);
    sim.force("link", link);
    sim.force("center", center);
    sim.alpha(1);
    sim.restart();
    simRef.current = sim;

    let lastTick = 0;
    const animate = (t: number): void => {
      if (!simRef.current) return;
      // Throttle to ~30fps; the actual integration happens in tick().
      if (t - lastTick > 33) {
        lastTick = t;
        simRef.current.tick(1);
        const simPositions = simRef.current.nodes();
        setNodes((cur) =>
          cur.map((node) => {
            const sn = simPositions.find((s) => s.id === node.id);
            if (!sn) return node;
            return { ...node, position: { x: sn.x ?? 0, y: sn.y ?? 0 } };
          }),
        );
        if (simRef.current.alpha() <= 0) {
          animRef.current = null;
          return;
        }
      }
      animRef.current = requestAnimationFrame(animate);
    };
    animRef.current = requestAnimationFrame(animate);

    return () => {
      if (animRef.current !== null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
      if (simRef.current) {
        simRef.current.stop();
        simRef.current = null;
      }
    };
  }, [cappedNodes, cappedEdges, initialPositions, mode, setNodes]);

  return (
    <div className="relative h-full min-h-[480px] w-full overflow-hidden rounded-xl border border-border bg-card" data-testid="graph-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};

export const GraphCanvas = (props: GraphCanvasProps): JSX.Element => (
  <ReactFlowProvider>
    <GraphCanvasInner {...props} />
  </ReactFlowProvider>
);
