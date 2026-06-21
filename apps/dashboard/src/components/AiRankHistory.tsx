/**
 * apps/dashboard/src/components/AiRankHistory.tsx — per-hypothesis
 * AI rank history sub-component.
 *
 * Used by the AI Reasoning page inside a Sheet. Shows every
 * `hypothesis_ranked` event for one hypothesis in reverse-chronological
 * order: rank score, evaluator, timestamp, reasoning. Source is
 * derived per-row from the event id: ids with `-r<hypId>` after the
 * tick prefix are agent-emitted (counted as `ai`), standalone ids
 * are operator-imported (also counted as `ai` for v1.2.0).
 */
import { type JSX } from "react";
import { Badge } from "@/shared/ui/badge";
import { formatIso } from "@/lib/format";

export interface RankHistoryEntry {
  readonly event_id: string;
  readonly created_at: string;
  readonly score: number;
  readonly reasoning: string;
  readonly evaluator: string;
}

interface AiRankHistoryProps {
  readonly entries: ReadonlyArray<RankHistoryEntry>;
  readonly emptyMessage?: string;
}

export const AiRankHistory = ({
  entries,
  emptyMessage = "(no AI rank history yet)",
}: AiRankHistoryProps): JSX.Element => {
  if (entries.length === 0) {
    return (
      <div
        className="rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground"
        data-testid="ai-reasoning-history-empty"
      >
        {emptyMessage}
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="ai-reasoning-history">
      {entries.map((e) => (
        <li
          key={e.event_id}
          className="flex flex-col gap-1 rounded border bg-card px-3 py-2"
          data-testid="ai-reasoning-history-row"
        >
          <div className="flex items-center justify-between gap-2">
            <span
              className="font-mono text-xs"
              data-testid="ai-reasoning-history-score"
            >
              score {e.score.toFixed(2)}
            </span>
            <Badge variant="neutral" data-testid="ai-reasoning-history-evaluator">
              {e.evaluator}
            </Badge>
          </div>
          <p
            className="text-xs text-foreground"
            data-testid="ai-reasoning-history-reasoning"
          >
            {e.reasoning}
          </p>
          <p
            className="font-mono text-[10px] text-muted-foreground"
            data-testid="ai-reasoning-history-created-at"
          >
            {formatIso(e.created_at)}
          </p>
        </li>
      ))}
    </ul>
  );
};
