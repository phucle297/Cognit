/**
 * apps/dashboard/src/pages/knowledge-graph.tsx — Knowledge Graph.
 *
 * Session: ?session= → last graph session → empty + selector.
 * FSD layer: pages.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Share2 } from "lucide-react";

import { useApi } from "@/lib/use-api";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Breadcrumb } from "@/shared/ui/breadcrumb";
import { EmptyState } from "@/shared/ui/empty-state";
import { ErrorState } from "@/shared/ui/error-state";
import { Skeleton } from "@/shared/ui/skeleton";
import { Sheet } from "@/shared/ui/sheet";
import {
  resolveGraphSession,
  writeLastGraphSession,
} from "@/shared/lib/graph-session";

import { GraphCanvas, type GraphResp, type LayoutMode } from "@/components/GraphCanvas";
import { GraphControls } from "@/components/GraphControls";

const AUTO_CONSTELLATION_THRESHOLD = 200;

const buildPath = (sessionId: string): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}/graph`;

type EventsResp = {
  readonly events: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly created_at: string;
    readonly payload: unknown;
  }>;
};

type SessionRow = {
  readonly id: string;
  readonly goal: string;
  readonly status: string;
};

type SessionsResp = { readonly sessions: ReadonlyArray<SessionRow> };

export const KnowledgeGraphPage = (): JSX.Element => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSession = searchParams.get("session");
  const sessionId = resolveGraphSession(urlSession);

  // Persist last session and sync URL when we resolved from storage.
  useEffect(() => {
    if (!sessionId) return;
    writeLastGraphSession(sessionId);
    if (!urlSession) {
      const next = new URLSearchParams(searchParams);
      next.set("session", sessionId);
      setSearchParams(next, { replace: true });
    }
  }, [sessionId, urlSession, searchParams, setSearchParams]);

  const sessionsList = useApi<SessionsResp>("/api/sessions");
  const apiPath = sessionId ? buildPath(sessionId) : null;

  const { data, error, loading, refetch } = useApi<GraphResp>(apiPath);
  const [mode, setMode] = useState<LayoutMode | null>(null);
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<GraphResp["nodes"][number] | null>(null);
  const [remountKey, setRemountKey] = useState(0);

  const events = useApi<EventsResp>(
    sessionId ? `/api/sessions/${sessionId}/events?limit=50` : null,
  );

  useEffect(() => {
    if (!data) return;
    if (mode !== null) return;
    setMode(data.nodes.length > AUTO_CONSTELLATION_THRESHOLD ? "constellation" : "physics");
  }, [data, mode]);

  const effectiveMode: LayoutMode = mode ?? "constellation";
  const nodeCount = data?.nodes.length ?? 0;
  const capped = nodeCount > 500;
  const graphResp: GraphResp = useMemo(
    () => data ?? { session_id: sessionId, nodes: [], edges: [] },
    [data, sessionId],
  );

  const kindFilter = searchParams.get("kind");
  const aiMode = searchParams.get("ai") === "1";
  const filteredNodes = useMemo<GraphResp["nodes"]>(() => {
    if (!kindFilter) return graphResp.nodes;
    return graphResp.nodes.filter(
      (n) => typeof n.entity_type === "string" && n.entity_type === kindFilter,
    );
  }, [graphResp.nodes, kindFilter]);
  const filteredEdges = useMemo<GraphResp["edges"]>(() => {
    if (!kindFilter) return graphResp.edges;
    const ids = new Set(filteredNodes.map((n) => n.id));
    return graphResp.edges.filter((e) => ids.has(e.from) || ids.has(e.to));
  }, [graphResp.edges, kindFilter, filteredNodes]);
  const filteredGraph: GraphResp = useMemo(
    () => ({
      session_id: graphResp.session_id,
      nodes: filteredNodes,
      edges: filteredEdges,
    }),
    [graphResp.session_id, filteredNodes, filteredEdges],
  );

  const onNodeClick = useCallback((n: GraphResp["nodes"][number]) => {
    setSelectedNode(n);
  }, []);

  const onZoomReset = useCallback(() => setRemountKey((k) => k + 1), []);

  const onPickSession = useCallback(
    (id: string): void => {
      if (!id) return;
      writeLastGraphSession(id);
      const next = new URLSearchParams(searchParams);
      next.set("session", id);
      setSearchParams(next, { replace: true });
      setMode(null);
      setSelectedNode(null);
    },
    [searchParams, setSearchParams],
  );

  const visibleNodeCount = filteredGraph.nodes.length;

  const relatedEvents = useMemo<
    ReadonlyArray<{ id: string; type: string; created_at: string }>
  >(() => {
    if (!selectedNode || !events.data) return [];
    const entityId = selectedNode.entity_id;
    return events.data.events
      .filter((e) => {
        const p = e.payload as Record<string, unknown> | null;
        if (!p || typeof p !== "object") return false;
        return Object.values(p).some(
          (v) => typeof v === "string" && (v === entityId || v.endsWith(entityId)),
        );
      })
      .slice(0, 12)
      .map((e) => ({ id: e.id, type: e.type, created_at: e.created_at }));
  }, [selectedNode, events.data]);

  const sessionSelect = (
    <label className="flex flex-col gap-1 text-xs" data-testid="kg-session-select-wrap">
      <span className="font-medium uppercase tracking-wide text-muted-foreground">Session</span>
      <select
        className="h-9 max-w-md rounded-[var(--radius)] border border-input bg-background px-3 text-sm"
        value={sessionId}
        onChange={(e): void => onPickSession(e.target.value)}
        data-testid="kg-session-select"
        aria-label="Select session for graph"
      >
        <option value="">Select a session…</option>
        {(sessionsList.data?.sessions ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.goal} ({s.status})
          </option>
        ))}
      </select>
    </label>
  );

  if (!sessionId) {
    return (
      <div className="flex flex-col gap-4 p-[var(--space-page-y)] px-[var(--space-page-x)]" data-testid="kg-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Graph" }]} />
        <EmptyState
          icon={Share2}
          title="No session selected"
          description="Pick a session below, or open Graph from Overview / Timeline."
        />
        {sessionSelect}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-3 p-[var(--space-page-y)] px-[var(--space-page-x)]" data-testid="kg-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Graph" }]} />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-3 p-[var(--space-page-y)] px-[var(--space-page-x)]" data-testid="kg-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Graph" }]} />
        <ErrorState
          message={error.message}
          onRetry={(): void => refetch()}
          data-testid="kg-error"
        />
        {sessionSelect}
      </div>
    );
  }

  return (
    <div
      className="flex h-[calc(100vh-var(--space-topbar-h))] flex-col"
      data-testid="kg-page"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-[var(--space-page-x)] py-2">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Graph" }]} />
        <div className="flex flex-wrap items-center gap-3">
          {sessionSelect}
          <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="kg-node-count">
            {kindFilter ? (
              <span data-testid="kg-kind-filter">
                kind: <span className="font-mono">{kindFilter}</span>
                {" · "}
                {visibleNodeCount} of {nodeCount} node{nodeCount === 1 ? "" : "s"}
              </span>
            ) : (
              <span>
                {nodeCount} node{nodeCount === 1 ? "" : "s"}
              </span>
            )}
            {aiMode ? (
              <span
                data-testid="kg-ai-mode"
                className="rounded-full border border-[var(--color-brand)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-brand)]"
              >
                AI reasoning mode
              </span>
            ) : null}
            <button
              type="button"
              className="text-xs text-[var(--color-brand)] hover:underline"
              onClick={(): void => navigate(`/timeline?session=${encodeURIComponent(sessionId)}`)}
              data-testid="kg-open-timeline"
            >
              Timeline
            </button>
          </div>
        </div>
      </div>
      <div className="relative flex-1">
        <div className="absolute left-4 top-4 z-10 max-w-xs">
          <GraphControls
            mode={effectiveMode}
            onModeChange={setMode}
            edges={filteredGraph.edges}
            visibleEdgeTypes={visibleEdgeTypes}
            onVisibleEdgeTypesChange={setVisibleEdgeTypes}
            onZoomReset={onZoomReset}
            nodeCount={visibleNodeCount}
            capped={capped}
          />
        </div>
        {nodeCount === 0 ? (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={Share2}
              title="No graph data"
              description="This session has no observations, findings, or hypotheses yet."
              data-testid="kg-empty"
            />
          </div>
        ) : visibleNodeCount === 0 && kindFilter !== null ? (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={Share2}
              title={`No ${kindFilter} nodes`}
              description={`This session has no ${kindFilter} entities. Try clearing the kind filter.`}
              data-testid="kg-empty-filtered"
            />
          </div>
        ) : (
          <GraphCanvas
            key={`${effectiveMode}-${remountKey}-${kindFilter ?? ""}-${aiMode ? "ai" : ""}`}
            data={filteredGraph}
            mode={effectiveMode}
            visibleEdgeTypes={visibleEdgeTypes}
            onNodeClick={onNodeClick}
            onFitView={onZoomReset}
          />
        )}
      </div>
      <Sheet
        open={selectedNode !== null}
        onClose={(): void => setSelectedNode(null)}
        title={selectedNode?.label ?? "Node"}
        description={selectedNode?.entity_type}
        width="md"
        data-testid="kg-node-sheet"
      >
        {selectedNode ? (
          <div className="flex flex-col gap-3" data-testid="kg-node-details">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Entity id</div>
              <div className="font-mono text-xs">{selectedNode.entity_id}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Type</div>
              <div>{selectedNode.entity_type}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Label</div>
              <div data-testid="kg-node-label">{selectedNode.label}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Related events
              </div>
              {relatedEvents.length === 0 ? (
                <div className="text-xs text-muted-foreground">No related events found.</div>
              ) : (
                <ul className="mt-1 flex flex-col gap-1" data-testid="kg-related-events">
                  {relatedEvents.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-center justify-between gap-2 rounded-[var(--radius)] border border-border bg-muted/40 px-2 py-1 text-xs"
                    >
                      <span className="font-mono">{e.type}</span>
                      <span className="font-mono text-muted-foreground">{e.id.slice(0, 8)}…</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
};

export type _KgApiError = ApiError;
void apiFetch;
