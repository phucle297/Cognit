/**
 * apps/dashboard/src/components/NodeSidePanel.tsx — node detail sheet.
 *
 * Sliding-in side panel that shows the full info for a clicked
 * node. Mirrors the visual idiom of the AppShell detail panes
 * (rounded card, sticky header) and reuses shared/ui primitives
 * so the test surface stays simple.
 */
import type { JSX } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../shared/ui/card";
import { Button } from "../shared/ui/button";
import { formatUlid } from "../shared/lib/format";
import type { GraphNode } from "./GraphCanvas";

export type NodeSidePanelProps = {
  readonly node: GraphNode | null;
  readonly onClose: () => void;
};

const nodeIdAndEntityId = (n: GraphNode): { idPart: string; entityId: string } => {
  // graph node id is `entity_type:entity_id` per the server.
  const idx = n.id.indexOf(":");
  if (idx === -1) return { idPart: n.id, entityId: n.entity_id };
  return { idPart: n.id, entityId: n.id.slice(idx + 1) };
};

export const NodeSidePanel = ({ node, onClose }: NodeSidePanelProps): JSX.Element | null => {
  if (!node) return null;
  const { idPart, entityId } = nodeIdAndEntityId(node);
  return (
    <Card
      className="fixed right-4 top-20 z-30 w-80 shadow-lg"
      data-testid="node-side-panel"
      role="dialog"
      aria-label="Node details"
    >
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="truncate" title={node.label}>
            {node.label}
          </CardTitle>
          <div className="text-xs text-muted-foreground">{node.entity_type}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} data-testid="node-side-panel-close">
          Close
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Node id</div>
          <div className="font-mono text-xs" data-testid="node-side-panel-id">
            {idPart}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Entity id</div>
          <div className="font-mono text-xs">{formatUlid(entityId)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Entity type</div>
          <div>{node.entity_type}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Label</div>
          <div data-testid="node-side-panel-label">{node.label}</div>
        </div>
      </CardContent>
    </Card>
  );
};
