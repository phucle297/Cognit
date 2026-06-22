/**
 * apps/dashboard/src/components/DecisionLog.tsx — supervisor tick log.
 *
 * Used by the AI Reasoning page. One row per supervisor tick: tick
 * event id (compact), actions applied, rank overrides applied,
 * truncation count, stop signal, and the most recent event
 * timestamp. The aggregator on the server buckets events by tick
 * prefix; this component renders the resulting shape.
 */
import { type JSX } from "react";
import { Badge } from "@/shared/ui/badge";
import { DataTable, type DataTableColumn } from "@/shared/ui/data-table";
import { EmptyState } from "@/shared/ui/empty-state";
import { formatIso, formatUlid } from "@/lib/format";
import { Sparkles } from "lucide-react";

export interface DecisionLogEntry {
  readonly tick_event_id: string;
  readonly actions_applied: number;
  readonly rank_overrides_applied: number;
  readonly actions_truncated: number;
  readonly stop: boolean;
  readonly created_at: string;
}

interface DecisionLogProps {
  readonly entries: ReadonlyArray<DecisionLogEntry>;
}

export const DecisionLog = ({ entries }: DecisionLogProps): JSX.Element => {
  if (entries.length === 0) {
    return (
      <div data-testid="ai-reasoning-decision-log-empty">
        <EmptyState
          icon={Sparkles}
          title="No supervisor ticks yet"
          description="Run `cognit agent run --once --session <id>` to record the first decision log entry."
        />
      </div>
    );
  }
  const columns: ReadonlyArray<DataTableColumn<DecisionLogEntry>> = [
    {
      key: "tick_event_id",
      header: "Tick",
      width: "10rem",
      render: (t) => (
        <span
          className="font-mono text-xs"
          data-testid="ai-reasoning-tick-id"
        >
          {formatUlid(t.tick_event_id)}
        </span>
      ),
    },
    {
      key: "actions_applied",
      header: "Actions",
      width: "5rem",
      render: (t) => (
        <span
          className="font-mono text-xs"
          data-testid="ai-reasoning-tick-actions"
        >
          {t.actions_applied}
        </span>
      ),
    },
    {
      key: "rank_overrides_applied",
      header: "Overrides",
      width: "6rem",
      render: (t) => (
        <span
          className="font-mono text-xs"
          data-testid="ai-reasoning-tick-overrides"
        >
          {t.rank_overrides_applied}
        </span>
      ),
    },
    {
      key: "actions_truncated",
      header: "Truncated",
      width: "6rem",
      render: (t) => (
        <span
          className="font-mono text-xs"
          data-testid="ai-reasoning-tick-truncated"
        >
          {t.actions_truncated}
        </span>
      ),
    },
    {
      key: "stop",
      header: "Stop",
      width: "4rem",
      render: (t) => (
        <Badge
          variant={t.stop ? "destructive" : "outline"}
          data-testid="ai-reasoning-tick-stop"
        >
          {t.stop ? "yes" : "no"}
        </Badge>
      ),
    },
    {
      key: "created_at",
      header: "When",
      width: "13rem",
      render: (t) => (
        <span className="font-mono text-xs text-muted-foreground">
          {formatIso(t.created_at)}
        </span>
      ),
    },
  ];
  return (
    <div data-testid="ai-reasoning-decision-log">
      <DataTable
        columns={columns}
        rows={entries}
        rowKey={(t) => t.tick_event_id}
        emptyMessage=""
      />
    </div>
  );
};
