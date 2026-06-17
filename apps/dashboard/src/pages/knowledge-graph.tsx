/**
 * apps/dashboard/src/pages/knowledge-graph.tsx — Knowledge Graph page.
 *
 * Phase 6.4: replaces the placeholder with a real
 * xyflow-backed graph. The page reads `?session=<id>` from the
 * URL, fetches `/sessions/:id/graph` via the shared `useApi`
 * hook, and lets the user toggle between physics and
 * constellation layouts.
 *
 * Auto-constellation: when the node count exceeds 200, the
 * default mode is constellation to avoid the browser melting.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { useSearchParams } from "react-router-dom";

import { Card, CardContent, CardHeader, CardTitle } from "../shared/ui/card";
import { useApi } from "../lib/use-api";

import { GraphCanvas, type GraphResp, type LayoutMode } from "@/components/GraphCanvas";
import { GraphControls } from "@/components/GraphControls";
import { NodeSidePanel } from "@/components/NodeSidePanel";

const AUTO_CONSTELLATION_THRESHOLD = 200;

const buildPath = (sessionId: string): string => `/sessions/${encodeURIComponent(sessionId)}/graph`;

export const KnowledgeGraphPage = (): JSX.Element => {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session") ?? "";
  const apiPath = sessionId ? buildPath(sessionId) : null;

  const { data, error, loading } = useApi<GraphResp>(apiPath);

  const [mode, setMode] = useState<LayoutMode | null>(null);
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<GraphResp["nodes"][number] | null>(null);

  // Once data arrives, decide the default layout mode.
  useEffect(() => {
    if (!data) return;
    if (mode !== null) return;
    setMode(data.nodes.length > AUTO_CONSTELLATION_THRESHOLD ? "constellation" : "physics");
  }, [data, mode]);

  const nodeCount = data?.nodes.length ?? 0;
  const capped = nodeCount > 500;

  const onNodeClick = useCallback((n: GraphResp["nodes"][number]) => {
    setSelectedNode(n);
  }, []);

  const onZoomReset = useCallback(() => {
    // GraphCanvas uses fitView on mount; a full re-mount is the
    // simplest way to trigger fitView again. We do this by
    // toggling a key on the canvas via a local remount counter.
    setRemountKey((k) => k + 1);
  }, []);
  const [remountKey, setRemountKey] = useState(0);

  const effectiveMode: LayoutMode = mode ?? "constellation";

  const graphResp: GraphResp = useMemo(
    () => data ?? { session_id: sessionId, nodes: [], edges: [] },
    [data, sessionId],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Knowledge Graph</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!sessionId ? (
            <p className="text-sm text-muted-foreground" data-testid="kg-missing-session">
              Open this page with a <code className="font-mono">?session=&lt;id&gt;</code> query parameter.
            </p>
          ) : loading ? (
            <p className="text-sm text-muted-foreground" data-testid="kg-loading">
              Loading graph for session <code className="font-mono">{sessionId}</code>…
            </p>
          ) : error ? (
            <p className="text-sm text-destructive" data-testid="kg-error">
              Failed to load graph: {error.message}
            </p>
          ) : (
            <>
              <GraphControls
                mode={effectiveMode}
                onModeChange={setMode}
                edges={graphResp.edges}
                visibleEdgeTypes={visibleEdgeTypes}
                onVisibleEdgeTypesChange={setVisibleEdgeTypes}
                onZoomReset={onZoomReset}
                nodeCount={nodeCount}
                capped={capped}
              />
              {nodeCount === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="kg-empty">
                  No nodes for this session yet.
                </p>
              ) : (
                <GraphCanvas
                  key={`${effectiveMode}-${remountKey}`}
                  data={graphResp}
                  mode={effectiveMode}
                  visibleEdgeTypes={visibleEdgeTypes}
                  onNodeClick={onNodeClick}
                  onFitView={onZoomReset}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>
      <NodeSidePanel node={selectedNode} onClose={(): void => setSelectedNode(null)} />
    </div>
  );
};
