/**
 * apps/dashboard/src/components/DecisionList.tsx
 *
 * FSD layer: components. Renders a vertical list of decisions.
 * Each row shows:
 *  - decision text
 *  - `based_on` conclusion links (edges where the decision is `to`
 *    and edge_type === "based_on"); display source node labels
 *  - `caused` experiment links (edges where the decision is `from`
 *    and edge_type === "caused"); display target node labels
 *  - `superseded_by` chain — a clickable text-link to the next
 *    decision in the chain (in-page anchor to the row's id)
 *
 * Edge shapes are passed in via props. The label resolver is
 * keyed by `${entity_type}:${entity_id}` to match the graph route
 * convention used by `apps/server/src/routes/sessions.ts`.
 */
import type { JSX } from "react";
import { Badge } from "@/shared/ui/badge";

export type DecisionLifecycle = "proposed" | "accepted" | "rejected" | "superseded";

export type DecisionListItem = {
  readonly id: string;
  readonly text: string;
  readonly state: DecisionLifecycle;
  readonly based_on_conclusion_ids: ReadonlyArray<string>;
  readonly superseded_by_decision_id: string | null;
  readonly created_at: string;
};

export type DecisionListEdge = {
  readonly id: string;
  readonly edge_type: string;
  readonly from_entity_type: string;
  readonly from_entity_id: string;
  readonly to_entity_type: string;
  readonly to_entity_id: string;
};

export type DecisionListProps = {
  readonly decisions: ReadonlyArray<DecisionListItem>;
  readonly edges: ReadonlyArray<DecisionListEdge>;
  /** Resolver keyed by `${entity_type}:${entity_id}` for edge labels. */
  readonly resolveLabel: (entityType: string, entityId: string) => string;
  /** Resolver for follow-on decisions in the superseded chain. */
  readonly resolveDecision: (id: string) => DecisionListItem | null;
};

export const DecisionList = ({
  decisions,
  edges,
  resolveLabel,
  resolveDecision,
}: DecisionListProps): JSX.Element => {
  if (decisions.length === 0) {
    return (
      <div
        data-testid="decision-empty"
        className="px-3 py-6 text-center text-sm text-muted-foreground"
      >
        No decisions in this section.
      </div>
    );
  }

  return (
    <div
      data-testid="decision-list"
      role="list"
      className="overflow-hidden rounded-md border border-divider bg-card shadow-[var(--shadow-sm)]"
    >
      {decisions.map((d, idx) => {
        const basedOn = edges.filter(
          (e) =>
            e.edge_type === "based_on" &&
            e.to_entity_type === "decision" &&
            e.to_entity_id === d.id,
        );
        const caused = edges.filter(
          (e) =>
            e.edge_type === "caused" &&
            e.from_entity_type === "decision" &&
            e.from_entity_id === d.id,
        );
        const supersededBy = d.superseded_by_decision_id
          ? resolveDecision(d.superseded_by_decision_id)
          : null;

        return (
          <div
            role="listitem"
            key={d.id}
            id={`decision-${d.id}`}
            data-testid="decision-row"
            data-decision-id={d.id}
            data-decision-state={d.state}
            style={{ "--stagger-index": idx } as React.CSSProperties}
            className="flex flex-col gap-2 border-b border-divider px-3 py-3 text-sm last:border-b-0 stagger-item"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-foreground">{d.text}</p>
              <Badge variant="outline" data-testid="decision-state">
                {d.state}
              </Badge>
            </div>

            {basedOn.length > 0 ? (
              <div data-testid="decision-based-on" className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  based on
                </span>
                {basedOn.map((e) => (
                  <Badge key={e.id} variant="secondary">
                    {resolveLabel(e.from_entity_type, e.from_entity_id)}
                  </Badge>
                ))}
              </div>
            ) : null}

            {caused.length > 0 ? (
              <div data-testid="decision-caused" className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  caused
                </span>
                {caused.map((e) => (
                  <Badge key={e.id} variant="secondary">
                    {resolveLabel(e.from_entity_type, e.from_entity_id)}
                  </Badge>
                ))}
              </div>
            ) : null}

            {supersededBy ? (
              <div
                data-testid="decision-superseded-chain"
                className="flex flex-wrap items-center gap-2"
              >
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  superseded by
                </span>
                <a
                  href={`#decision-${supersededBy.id}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {supersededBy.text}
                </a>
                {supersededBy.superseded_by_decision_id ? (
                  <span className="text-xs text-muted-foreground">
                    (further superseded — follow the chain)
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};