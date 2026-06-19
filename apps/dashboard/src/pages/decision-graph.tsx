/**
 * apps/dashboard/src/pages/decision-graph.tsx — Decision Graph (6.8.2.P4).
 *
 * Full-bleed xyflow canvas with decision-entity theme. Right
 * Sheet on node click (title / state / based-on / superseded
 * chain). Sidebar auto-collapses on mount, restores on unmount.
 *
 * FSD layer: pages. Reads `?session=<id>` from the URL.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { GitBranch } from "lucide-react";

import { useApi } from "@/lib/use-api";
import { Breadcrumb } from "@/shared/ui/breadcrumb";
import { DataTable, type DataTableColumn } from "@/shared/ui/data-table";
import { EmptyState } from "@/shared/ui/empty-state";
import { ErrorState } from "@/shared/ui/error-state";
import { Sheet } from "@/shared/ui/sheet";
import { Skeleton } from "@/shared/ui/skeleton";
import { StatusPill } from "@/shared/ui/status-pill";
import type { StatusKey } from "@/shared/config/status";
import { Card, CardContent } from "@/shared/ui/card";

import { GraphCanvas, type GraphResp, type LayoutMode } from "@/components/GraphCanvas";
import { GraphControls } from "@/components/GraphControls";
import { useSidebar } from "@/widgets/sidebar/sidebar-provider";

type DecisionStateShape = {
  readonly id: string;
  readonly text: string;
  readonly state: "proposed" | "accepted" | "rejected" | "superseded";
  readonly based_on_conclusion_ids: ReadonlyArray<string>;
  readonly superseded_by_decision_id: string | null;
  readonly created_at: string;
};

type StateResp = {
  readonly session: { readonly id: string };
  readonly state: {
    readonly decisions: Record<string, DecisionStateShape>;
  };
};

const AUTO_CONSTELLATION_THRESHOLD = 200;

const DECISION_STATUS: Record<DecisionStateShape["state"], StatusKey> = {
  proposed: "pending",
  accepted: "verified",
  rejected: "failed",
  superseded: "archived",
};

const flatten = <T,>(m: Record<string, T> | undefined | null): T[] => (m ? Object.values(m) : []);

export const DecisionGraphPage = (): JSX.Element => {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session") ?? "";
  const { setCollapsed } = useSidebar();

  useEffect(() => {
    setCollapsed(true);
    return (): void => setCollapsed(false);
  }, [setCollapsed]);

  const statePath = sessionId ? `/api/sessions/${sessionId}/state` : null;
  const graphPath = sessionId ? `/api/sessions/${sessionId}/graph` : null;
  const state = useApi<StateResp>(statePath);
  const graph = useApi<GraphResp>(graphPath);

  const [mode, setMode] = useState<LayoutMode | null>(null);
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<Set<string>>(new Set());
  const [remountKey, setRemountKey] = useState(0);
  const [selectedNode, setSelectedNode] = useState<GraphResp["nodes"][number] | null>(null);

  const decisions: ReadonlyArray<DecisionStateShape> = useMemo(
    () => flatten(state.data?.state.decisions),
    [state.data],
  );

  useEffect(() => {
    if (!graph.data) return;
    if (mode !== null) return;
    setMode(graph.data.nodes.length > AUTO_CONSTELLATION_THRESHOLD ? "constellation" : "physics");
  }, [graph.data, mode]);

  const onNodeClick = useCallback((n: GraphResp["nodes"][number]) => {
    setSelectedNode(n);
  }, []);

  const onZoomReset = useCallback(() => setRemountKey((k) => k + 1), []);

  const effectiveMode: LayoutMode = mode ?? "constellation";
  const nodeCount = graph.data?.nodes.length ?? 0;
  const capped = nodeCount > 500;
  const graphResp: GraphResp = useMemo(
    () => graph.data ?? { session_id: sessionId, nodes: [], edges: [] },
    [graph.data, sessionId],
  );

  const selectedDecision = useMemo<DecisionStateShape | null>(() => {
    if (!selectedNode) return null;
    return decisions.find((d) => d.id === selectedNode.entity_id) ?? null;
  }, [selectedNode, decisions]);

  const tableColumns: ReadonlyArray<DataTableColumn<DecisionStateShape>> = [
    {
      key: "text",
      header: "Decision",
      render: (d) => <span className="font-medium">{d.text}</span>,
    },
    {
      key: "state",
      header: "State",
      width: "10rem",
      render: (d) => <StatusPill status={DECISION_STATUS[d.state]} />,
    },
    {
      key: "created_at",
      header: "Created",
      width: "12rem",
      render: (d) => <span className="font-mono text-xs text-muted-foreground">{d.created_at.slice(0, 19)}Z</span>,
    },
  ];

  if (!sessionId) {
    return (
      <div className="flex flex-col gap-3" data-testid="decision-graph-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Decision Graph" }]} />
        <EmptyState
          icon={GitBranch}
          title="No session selected"
          description="Open the Decision Graph from a session timeline to inspect its decision tree."
        />
      </div>
    );
  }

  if (state.loading || graph.loading) {
    return (
      <div className="flex flex-col gap-3" data-testid="decision-graph-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Decision Graph" }]} />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  if (state.error || graph.error) {
    return (
      <div className="flex flex-col gap-3" data-testid="decision-graph-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Decision Graph" }]} />
        <ErrorState
          message={(state.error ?? graph.error)!.message}
          onRetry={(): void => {
            state.refetch();
            graph.refetch();
          }}
          data-testid="decision-graph-error"
        />
      </div>
    );
  }

  return (
    <div
      className="-mx-[var(--space-page-x)] -my-[var(--space-page-y)] flex h-[calc(100vh-3rem)] flex-col"
      data-testid="decision-graph-page"
    >
      <div className="flex items-center justify-between border-b px-[var(--space-page-x)] py-2">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Decision Graph" }]} />
        <div className="text-xs text-muted-foreground" data-testid="decision-count">
          {decisions.length} decision{decisions.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="relative flex-1">
        <div className="absolute left-4 top-4 z-10 max-w-xs">
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
        </div>
        {nodeCount === 0 ? (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={GitBranch}
              title="No decision data"
              description="This session has no decisions recorded yet."
              data-testid="decision-empty"
            />
          </div>
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
      </div>
      {decisions.length > 0 ? (
        <div className="border-t bg-card px-[var(--space-page-x)] py-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">All decisions</h3>
          <Card>
            <CardContent className="p-0">
              <DataTable
                columns={tableColumns}
                rows={decisions}
                rowKey={(d) => d.id}
                onRowClick={(d) =>
                  setSelectedNode({ id: `decision:${d.id}`, entity_id: d.id, entity_type: "decision", label: d.text })
                }
                emptyMessage=""
              />
            </CardContent>
          </Card>
        </div>
      ) : null}
      <Sheet
        open={selectedNode !== null}
        onClose={(): void => setSelectedNode(null)}
        title={selectedNode?.label ?? "Decision"}
        description={selectedNode?.entity_type}
        width="md"
        data-testid="decision-sheet"
      >
        {selectedNode ? (
          <div className="flex flex-col gap-3" data-testid="decision-details">
            {selectedDecision ? (
              <>
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">State</div>
                  <div className="mt-1">
                    <StatusPill status={DECISION_STATUS[selectedDecision.state]} />
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Based on conclusions</div>
                  <ul className="mt-1 flex flex-col gap-1" data-testid="decision-based-on">
                    {selectedDecision.based_on_conclusion_ids.length === 0 ? (
                      <li className="text-xs text-muted-foreground">None recorded</li>
                    ) : (
                      selectedDecision.based_on_conclusion_ids.map((c) => (
                        <li key={c} className="rounded border bg-muted/40 px-2 py-1 font-mono text-xs">
                          {c}
                        </li>
                      ))
                    )}
                  </ul>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Superseded by</div>
                  <div className="mt-1 font-mono text-xs">
                    {selectedDecision.superseded_by_decision_id ?? "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Created</div>
                  <div className="mt-1 font-mono text-xs">{selectedDecision.created_at}</div>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No decision entity linked to this node.</p>
            )}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
};
