/**
 * apps/dashboard/src/components/GraphControls.tsx — control bar.
 *
 * Owns the layout toggle (Physics / Constellation), the
 * edge-type multiselect, and the zoom-reset button. The parent
 * passes the current mode + a setter; the controls remain
 * stateless aside from local toggle state for the multiselect
 * popover.
 */
import { useMemo, useState, type JSX } from "react";
import { Button } from "../shared/ui/button";
import { Card } from "../shared/ui/card";
import { cn } from "../shared/lib/cn";
import type { LayoutMode } from "./GraphCanvas";
import type { GraphEdge } from "./GraphCanvas";

export type GraphControlsProps = {
  readonly mode: LayoutMode;
  readonly onModeChange: (mode: LayoutMode) => void;
  readonly edges: readonly GraphEdge[];
  readonly visibleEdgeTypes: ReadonlySet<string>;
  readonly onVisibleEdgeTypesChange: (next: Set<string>) => void;
  readonly onZoomReset: () => void;
  readonly nodeCount: number;
  readonly capped: boolean;
};

export const GraphControls = ({
  mode,
  onModeChange,
  edges,
  visibleEdgeTypes,
  onVisibleEdgeTypesChange,
  onZoomReset,
  nodeCount,
  capped,
}: GraphControlsProps): JSX.Element => {
  const [open, setOpen] = useState(false);

  const edgeTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of edges) counts.set(e.edge_type, (counts.get(e.edge_type) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [edges]);

  const allTypeList = useMemo(() => edgeTypeCounts.map(([t]) => t), [edgeTypeCounts]);

  /**
   * Empty set = show all. First uncheck seeds the full set then
   * removes one type so the checkbox matches user intent.
   */
  const toggleType = (type: string): void => {
    let next: Set<string>;
    if (visibleEdgeTypes.size === 0) {
      next = new Set(allTypeList);
      next.delete(type);
    } else if (visibleEdgeTypes.has(type)) {
      next = new Set(visibleEdgeTypes);
      next.delete(type);
    } else {
      next = new Set(visibleEdgeTypes);
      next.add(type);
      // All selected → collapse back to empty (= all) for simpler state.
      if (next.size === allTypeList.length && allTypeList.every((t) => next.has(t))) {
        next = new Set();
      }
    }
    onVisibleEdgeTypesChange(next);
  };

  const clearTypes = (): void => onVisibleEdgeTypesChange(new Set());
  const allTypes = (): void => onVisibleEdgeTypesChange(new Set());

  return (
    <Card className="flex flex-wrap items-center gap-2 p-3" data-testid="graph-controls">
      <div className="flex items-center gap-1" role="group" aria-label="Layout">
        <Button
          size="sm"
          variant={mode === "physics" ? "default" : "outline"}
          onClick={(): void => onModeChange("physics")}
          data-testid="layout-physics"
        >
          Physics
        </Button>
        <Button
          size="sm"
          variant={mode === "constellation" ? "default" : "outline"}
          onClick={(): void => onModeChange("constellation")}
          data-testid="layout-constellation"
        >
          Constellation
        </Button>
      </div>

      <div className="relative">
        <Button size="sm" variant="outline" onClick={(): void => setOpen((o) => !o)} data-testid="edge-type-toggle">
          Edge types
          {visibleEdgeTypes.size > 0 ? ` (${visibleEdgeTypes.size})` : ""}
        </Button>
        {open ? (
          <div
            className="absolute z-20 mt-1 max-h-64 w-56 overflow-auto rounded-md border bg-card p-2 shadow-md"
            data-testid="edge-type-menu"
          >
            <div className="mb-1 flex items-center justify-between gap-1">
              <Button size="sm" variant="ghost" onClick={allTypes} className="h-7 px-2 text-xs">
                All
              </Button>
              <Button size="sm" variant="ghost" onClick={clearTypes} className="h-7 px-2 text-xs">
                Clear
              </Button>
            </div>
            {edgeTypeCounts.length === 0 ? (
              <div className="px-2 py-1 text-xs text-muted-foreground">No edges</div>
            ) : (
              <ul className="space-y-1">
                {edgeTypeCounts.map(([type, count]) => {
                  const checked = visibleEdgeTypes.size === 0 || visibleEdgeTypes.has(type);
                  return (
                    <li key={type}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(): void => toggleType(type)}
                            data-testid={`edge-type-${type}`}
                          />
                          <span>{type}</span>
                        </span>
                        <span className="text-muted-foreground">{count}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      <Button size="sm" variant="outline" onClick={onZoomReset} data-testid="zoom-reset">
        Reset zoom
      </Button>

      <div className="ml-auto text-xs text-muted-foreground" data-testid="graph-stats">
        {nodeCount} nodes{capped ? " (capped at 500)" : ""}
      </div>
    </Card>
  );
};
