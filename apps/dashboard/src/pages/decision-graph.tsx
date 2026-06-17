/**
 * apps/dashboard/src/pages/decision-graph.tsx — Decision Graph page (6.5).
 *
 * FSD layer: pages. Reads the session state via
 * `GET /sessions/:id/state`, then `GET /sessions/:id/edges?edge_type=based_on|caused`
 * for the two edge kinds the graph needs. Splits decisions into
 * "accepted" and "rejected" sections, then delegates to
 * `<DecisionList>` for the row rendering (based_on / caused links,
 * superseded chain).
 *
 * Session id comes from the URL search params (`?session=<ulid>`),
 * matching the Timeline page convention.
 *
 * Wire format:
 *  - SessionState map fields (hypotheses, decisions, conclusions,
 *    verifications, artifacts, theories, experiments) are serialized
 *    as plain objects keyed by entity id (see
 *    `packages/db/src/snapshot-service.ts` `serializeState`). The
 *    pages rehydrate them into arrays of values for rendering.
 */
import { useMemo, type JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "@/lib/use-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import {
  DecisionList,
  type DecisionListEdge,
  type DecisionListItem,
} from "@/components/DecisionList";

type DecisionLifecycle = "proposed" | "accepted" | "rejected" | "superseded";

type DecisionStateShape = {
  readonly id: string;
  readonly text: string;
  readonly state: DecisionLifecycle;
  readonly based_on_conclusion_ids: ReadonlyArray<string>;
  readonly superseded_by_decision_id: string | null;
  readonly created_at: string;
};

type ConclusionStateShape = {
  readonly id: string;
  readonly text: string;
  readonly state: string;
};

type ExperimentStateShape = {
  readonly id: string;
  readonly design: string;
};

type StateResp = {
  readonly session: { readonly id: string };
  readonly state: {
    readonly decisions: Record<string, DecisionStateShape>;
    readonly conclusions: Record<string, ConclusionStateShape>;
    readonly experiments: Record<string, ExperimentStateShape>;
  };
};

type EdgesResp = {
  readonly edges: ReadonlyArray<DecisionListEdge>;
};

/**
 * Convert a server-serialized Map field (object keyed by entity id)
 * back into an array of its values. The snapshot service writes
 * Maps as key-sorted plain objects (see
 * `packages/db/src/snapshot-service.ts` `serializeState`), so the
 * wire shape is `Record<string, T>`.
 */
const flattenMap = <T,>(input: Record<string, T> | undefined | null): T[] => {
  if (!input) return [];
  return Object.values(input);
};

export const DecisionGraphPage = (): JSX.Element => {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session");

  const statePath = sessionId ? `/sessions/${sessionId}/state` : null;
  const edgesPath = sessionId
    ? `/sessions/${sessionId}/edges?edge_type=based_on|caused`
    : null;
  const state = useApi<StateResp>(statePath);
  const edges = useApi<EdgesResp>(edgesPath);

  const decisions: ReadonlyArray<DecisionListItem> = useMemo(() => {
    if (!state.data?.state.decisions) return [];
    const raw = flattenMap(state.data.state.decisions);
    return raw.map((d) => ({
      id: d.id,
      text: d.text,
      state: d.state,
      based_on_conclusion_ids: d.based_on_conclusion_ids ?? [],
      superseded_by_decision_id: d.superseded_by_decision_id ?? null,
      created_at: d.created_at,
    }));
  }, [state.data]);

  const labelMap = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    if (state.data?.state.conclusions) {
      for (const c of flattenMap(state.data.state.conclusions)) {
        map[`conclusion:${c.id}`] = c.text;
      }
    }
    if (state.data?.state.experiments) {
      for (const e of flattenMap(state.data.state.experiments)) {
        map[`experiment:${e.id}`] = e.design;
      }
    }
    for (const d of decisions) {
      map[`decision:${d.id}`] = d.text;
    }
    return map;
  }, [state.data, decisions]);

  const decisionById = useMemo<Record<string, DecisionListItem>>(() => {
    const map: Record<string, DecisionListItem> = {};
    for (const d of decisions) map[d.id] = d;
    return map;
  }, [decisions]);

  const resolveLabel = (entityType: string, entityId: string): string => {
    const key = `${entityType}:${entityId}`;
    return labelMap[key] ?? `${entityType}:${entityId}`;
  };
  const resolveDecision = (id: string): DecisionListItem | null =>
    decisionById[id] ?? null;

  const accepted = decisions.filter((d) => d.state === "accepted");
  // "superseded" decisions are folded into the rejected section so
  // a chain (A → B → C) renders the older links in a visible row.
  // Proposals (not yet accepted/rejected) are excluded.
  const rejected = decisions.filter((d) => d.state === "rejected" || d.state === "superseded");

  if (!sessionId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Decision Graph</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="decision-graph-empty-session" className="text-sm text-muted-foreground">
            Open a session to view its decisions.
          </p>
        </CardContent>
      </Card>
    );
  }

  const edgeList = edges.data?.edges ?? [];

  return (
    <div data-testid="decision-graph-page" className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Decision Graph</h1>
      {state.loading && decisions.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading decisions…</p>
      ) : null}
      {state.error ? (
        <p data-testid="decision-graph-error" className="text-sm text-destructive">
          {state.error.api.message}
        </p>
      ) : null}

      <section
        data-testid="decision-accepted"
        className="flex flex-col gap-3"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Accepted ({accepted.length})
        </h2>
        <DecisionList
          decisions={accepted}
          edges={edgeList}
          resolveLabel={resolveLabel}
          resolveDecision={resolveDecision}
        />
      </section>

      <section
        data-testid="decision-rejected"
        className="flex flex-col gap-3"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Rejected ({rejected.length})
        </h2>
        <DecisionList
          decisions={rejected}
          edges={edgeList}
          resolveLabel={resolveLabel}
          resolveDecision={resolveDecision}
        />
      </section>
    </div>
  );
};