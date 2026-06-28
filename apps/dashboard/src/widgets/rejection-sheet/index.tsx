/**
 * apps/dashboard/src/widgets/rejection-sheet/index.tsx — "Why was
 * this rejected?" sheet (Phase B.4 / 3.2 / 5.3).
 *
 * Collapses the recovery story from 10+ steps to 4: the user opens
 * the dashboard, picks a session, sees a `hypothesis_rejected` row
 * on the Timeline, clicks the row action, and a side Sheet renders
 * the supporting/contradicting observations + linked verification +
 * AI rank history + a "Resume this investigation" button.
 *
 * Data sources:
 *   - GET /api/sessions/:id/recovery
 *       rejected_hypotheses[] now carries `supporting_observations`
 *       (top 3) and `contradicting_observations` (top 1) joined
 *       server-side from `state.edges` (supports/contradicts +
 *       derived_from) and the finding → observation links. Each
 *       entry is `{ id, text, ts }` — `id` is the observation ULID.
 *   - GET /api/sessions/:id/ai-reasoning?hypothesis=<id>
 *       adds `rank_history: { event_id, created_at, score }[]` in
 *       chronological order — the AI supervisor's `payload.score`
 *       values, oldest first. The dashboard renders this as a
 *       Sparkline (no synthetic fallback).
 *
 * FSD layer: widgets. Reuses the project Sheet primitive.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, ListRestart, ShieldAlert, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";

import { Sheet } from "@/shared/ui/sheet";
import { Badge } from "@/shared/ui/badge";
import { Card, CardContent } from "@/shared/ui/card";
import { Skeleton } from "@/shared/ui/skeleton";
import { EmptyState } from "@/shared/ui/empty-state";

import { apiFetch, ApiError } from "@/lib/api-client";
import { formatIso, formatUlid } from "@/lib/format";

export interface RejectionSummary {
  readonly hypothesis_id: string;
  readonly title: string;
  readonly text: string;
  readonly reason_type: "evidence" | "superseded" | "constraint" | null;
  readonly reason: string | null;
  readonly superseded_by_id: string | null;
  readonly created_at: string;
}

export interface RejectionSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The session the rejected hypothesis belongs to. */
  readonly sessionId: string;
  /** Wire shape from `hypothesis_rejected` payload + the recovery
   *  envelope's `rejected_hypotheses[]` entry. The Timeline row
   *  extracts these from the recovery endpoint when it can. */
  readonly summary: RejectionSummary | null;
}

interface RecoveryRecord {
  readonly rejected_hypotheses: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly text: string;
    readonly reason: string | null;
    readonly reason_type: "evidence" | "superseded" | "constraint" | null;
    readonly superseded_by_id: string | null;
    readonly created_at: string;
    /**
     * Top-3 observations reachable through findings/conclusions
     * that `support` this hypothesis via an `edge_created` event.
     * Empty when no supporting edge exists. Each entry is the
     * observation's own `{ id, text, ts }` — the id is the
     * observation ULID, linkable to /timeline?focus=<id>.
     */
    readonly supporting_observations: ReadonlyArray<{
      readonly id: string;
      readonly text: string;
      readonly ts: string;
    }>;
    /**
     * Top-1 observation reachable through findings/conclusions that
     * `contradict` this hypothesis. Empty when no contradicting edge
     * exists. We surface only one so the rejection sheet stays
     * focused on "the one thing that killed it".
     */
    readonly contradicting_observations: ReadonlyArray<{
      readonly id: string;
      readonly text: string;
      readonly ts: string;
    }>;
  }>;
  readonly latest_verification: Record<
    string,
    {
      readonly id: string;
      readonly hypothesis_id: string;
      readonly type: "test" | "lint" | "build" | "exec" | "typecheck";
      readonly command: string;
      readonly state: "started" | "passed" | "failed" | "errored" | "cancelled";
      readonly started_at: string;
      readonly ended_at: string | null;
    }
  >;
}

interface AiReasoningResp {
  readonly ranked: ReadonlyArray<{
    readonly hypothesis_id: string;
    readonly ai_score: number | null;
    readonly ai_rank_event_id: string | null;
  }>;
  readonly decision_log: ReadonlyArray<unknown>;
  /**
   * Optional — present when the request includes
   * `?hypothesis=<id>`. Server-side filter: only events whose
   * `payload.hypothesis_id` matches the query param, ordered
   * `created_at` ASC.
   */
  readonly hypothesis_id?: string;
  readonly rank_history?: ReadonlyArray<RankHistoryEntry>;
}

interface RankHistoryEntry {
  readonly event_id: string;
  readonly created_at: string;
  readonly score: number;
}

const REASON_BADGE: Record<NonNullable<RejectionSummary["reason_type"]>, "failed" | "archived"> = {
  evidence: "failed",
  superseded: "archived",
  constraint: "failed",
};

const Sparkline = ({ values }: { values: ReadonlyArray<number> }): JSX.Element => {
  if (values.length < 2) {
    return <span className="font-mono text-xs text-muted-foreground">—</span>;
  }
  const w = 120;
  const h = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const points = values
    .map((v, i) => `${(i * step).toFixed(2)},${(h - ((v - min) / span) * h).toFixed(2)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-[var(--color-brand)]" aria-label="AI rank history sparkline">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
    </svg>
  );
};

const ObservationList = ({
  title,
  icon: Icon,
  badge,
  items,
  empty,
  sessionId,
}: {
  readonly title: string;
  readonly icon: typeof ThumbsUp;
  readonly badge: "verified" | "failed" | "pending";
  readonly items: ReadonlyArray<{ id: string; text: string; ts?: string }>;
  readonly empty: string;
  readonly sessionId: string;
}): JSX.Element => {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Icon className="size-3.5" aria-hidden /> {title}
        </div>
        <Badge variant={badge}>{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid={`rejection-${badge}-empty`}>
          {empty}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid={`rejection-${badge}-list`}>
          {items.slice(0, 3).map((it) => (
            <li
              key={it.id}
              className="flex flex-col gap-0.5 rounded border bg-muted/40 px-2 py-1.5"
              data-testid={`rejection-${badge}-item`}
            >
              <Link
                to={`/timeline?session=${encodeURIComponent(sessionId)}&focus=${encodeURIComponent(it.id)}`}
                className="flex flex-col gap-0.5 hover:opacity-90"
                data-testid={`rejection-${badge}-link`}
              >
                <span className="text-xs">{it.text}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {it.ts ? formatIso(it.ts) : formatUlid(it.id)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const RejectionSheet = ({ open, onClose, sessionId, summary }: RejectionSheetProps): JSX.Element => {
  const [recovery, setRecovery] = useState<RecoveryRecord | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [rankHistory, setRankHistory] = useState<ReadonlyArray<RankHistoryEntry>>([]);

  // Fetch the recovery envelope + AI reasoning on open. Both
  // endpoints already exist and return everything we need.
  useEffect(() => {
    if (!open || summary === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRecovery(null);
    setRankHistory([]);
    const aiUrl =
      `/api/sessions/${encodeURIComponent(sessionId)}/ai-reasoning` +
      `?hypothesis=${encodeURIComponent(summary.hypothesis_id)}`;
    Promise.all([
      apiFetch<RecoveryRecord>(`/api/sessions/${encodeURIComponent(sessionId)}/recovery`).catch((err: unknown) => {
        if (err instanceof ApiError) throw new Error(err.message);
        throw err;
      }),
      apiFetch<AiReasoningResp>(aiUrl).catch((): AiReasoningResp => ({
        ranked: [],
        decision_log: [],
        rank_history: [],
      })),
    ])
      .then(([rec, ai]) => {
        if (cancelled) return;
        setRecovery(rec);
        // Server-side filtered: only `hypothesis_ranked` events
        // whose `payload.hypothesis_id` matches the rejected
        // hypothesis, ordered `created_at` ASC. Each entry is the
        // verbatim `payload.score` value (0..1) so the Sparkline
        // renders the supervisor's actual rank trajectory rather
        // than a synthetic stand-in.
        const history = ai.rank_history ?? [];
        setRankHistory(history);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load rejection summary.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, summary]);

  const linkedVerification = useMemo(() => {
    if (!recovery || !summary) return null;
    const rec = recovery.latest_verification[summary.hypothesis_id];
    return rec ?? null;
  }, [recovery, summary]);

  // Supporting + contradicting observations come from the recovery
  // envelope's `rejected_hypotheses[id]` entry. The server joins
  // `state.edges` (supports/contradicts + derived_from) with the
  // finding → observation links and surfaces the top N per
  // direction. No client-side fan-out, no extra fetch.
  const supporting = useMemo<ReadonlyArray<{ id: string; text: string; ts?: string }>>(() => {
    if (!recovery || !summary) return [];
    const row = recovery.rejected_hypotheses.find((h) => h.id === summary.hypothesis_id);
    if (!row) return [];
    return row.supporting_observations.map((o) => ({ id: o.id, text: o.text, ts: o.ts }));
  }, [recovery, summary]);

  const contradicting = useMemo<ReadonlyArray<{ id: string; text: string; ts?: string }>>(() => {
    if (!recovery || !summary) return [];
    const row = recovery.rejected_hypotheses.find((h) => h.id === summary.hypothesis_id);
    if (!row) return [];
    return row.contradicting_observations.map((o) => ({ id: o.id, text: o.text, ts: o.ts }));
  }, [recovery, summary]);

  const sparklineValues = useMemo<ReadonlyArray<number>>(() => rankHistory.map((r) => r.score), [rankHistory]);

  const reasonLabel = summary?.reason_type ?? null;
  const reasonText = summary?.reason ?? null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Why was this rejected?"
      description={
        summary ? `Hypothesis ${summary.hypothesis_id.slice(0, 12)}… · session ${sessionId.slice(0, 8)}…` : undefined
      }
      width="lg"
      data-testid="rejection-sheet"
    >
      {summary === null ? (
        <EmptyState
          icon={ShieldAlert}
          title="No rejection selected"
          description="Open a hypothesis_rejected row from the timeline to inspect the reasoning here."
        />
      ) : loading ? (
        <div className="flex flex-col gap-2" data-testid="rejection-sheet-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive" data-testid="rejection-sheet-error">
          {error}
        </p>
      ) : (
        <div className="flex flex-col gap-4" data-testid="rejection-sheet-body">
          <Card>
            <CardContent className="flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Hypothesis
                </span>
                {reasonLabel ? (
                  <Badge variant={REASON_BADGE[reasonLabel]} data-testid="rejection-reason-type">
                    {reasonLabel}
                  </Badge>
                ) : null}
              </div>
              <div className="text-sm font-medium" data-testid="rejection-title">
                {summary.title || summary.text}
              </div>
              {reasonText ? (
                <p className="text-xs text-muted-foreground" data-testid="rejection-reason">
                  {reasonText}
                </p>
              ) : null}
              {summary.superseded_by_id ? (
                <p className="font-mono text-[10px] text-muted-foreground">
                  Superseded by {summary.superseded_by_id}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <ObservationList
            title="Supporting observations"
            icon={ThumbsUp}
            badge="verified"
            items={supporting}
            empty="No supporting observations recorded for this hypothesis."
            sessionId={sessionId}
          />

          <ObservationList
            title="Contradicting observations"
            icon={ThumbsDown}
            badge="failed"
            items={contradicting}
            empty="No contradicting observations recorded for this hypothesis."
            sessionId={sessionId}
          />

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <ShieldAlert className="size-3.5" aria-hidden /> Linked check
              </div>
              {linkedVerification ? (
                <Badge
                  variant={
                    linkedVerification.state === "passed"
                      ? "verified"
                      : linkedVerification.state === "failed" || linkedVerification.state === "errored"
                        ? "failed"
                        : "pending"
                  }
                  data-testid="rejection-verification-state"
                >
                  {linkedVerification.state}
                </Badge>
              ) : null}
            </div>
            {linkedVerification ? (
              <div className="flex flex-col gap-1 rounded border bg-muted/40 px-3 py-2" data-testid="rejection-verification">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs">{linkedVerification.type}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{linkedVerification.id.slice(0, 12)}…</span>
                </div>
                <pre className="overflow-x-auto rounded bg-background p-2 font-mono text-xs">
                  {linkedVerification.command}
                </pre>
                <span className="text-[10px] text-muted-foreground">
                  started {formatIso(linkedVerification.started_at)}
                  {linkedVerification.ended_at ? ` · ended ${formatIso(linkedVerification.ended_at)}` : " · running"}
                </span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="rejection-verification-empty">
                No check linked to this hypothesis.
              </p>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Sparkles className="size-3.5" aria-hidden /> AI rank history
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                {sparklineValues.length} sample{sparklineValues.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex items-center gap-3 rounded border bg-muted/40 px-3 py-2" data-testid="rejection-ai-sparkline">
              <Sparkline values={sparklineValues} />
              <span className="text-xs text-muted-foreground">
                {sparklineValues.length > 0
                  ? `min ${Math.min(...sparklineValues).toFixed(2)} · max ${Math.max(...sparklineValues).toFixed(2)}`
                  : "no rank samples yet"}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t pt-3">
            <Link
              to={`/timeline?session=${encodeURIComponent(sessionId)}`}
              onClick={onClose}
              className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
              data-testid="rejection-open-timeline"
            >
              <ExternalLink className="size-3.5" aria-hidden /> Open session timeline
            </Link>
            <Link
              to={`/timeline?session=${encodeURIComponent(sessionId)}`}
              onClick={onClose}
              data-testid="rejection-resume"
              className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <ListRestart className="size-4" aria-hidden /> Resume this investigation
            </Link>
          </div>
        </div>
      )}
    </Sheet>
  );
};
