/**
 * apps/dashboard/src/pages/ai-reasoning.tsx — AI Reasoning tab (C4).
 *
 * FSD layer: pages. Reads `?session=` from the URL. Initial fetch
 * is `GET /api/sessions/:id/ai-reasoning` (ranked + decision_log).
 * Live updates stream through `GET /api/sessions/:id/ai-reasoning/stream`
 * — the server scopes the bus subscription to {sessionId,
 * hypothesis_ranked} so the tab does not need to client-filter.
 *
 * Dedup invariant: the SSE URL includes `?last_event_id=` derived
 * from the GET snapshot's highest `ai_rank_event_id`. The server
 * replays only events strictly after that cursor, so any
 * `hypothesis_ranked` event that landed before the GET response
 * arrives via the snapshot (not via SSE). Events that arrive AFTER
 * the GET response are streamed live, filtered by a snapshot-id set
 * on the client so a server-side replay race cannot double-count.
 * Together: every row counted exactly once, snapshot OR SSE.
 *
 * Visibility: SSE pauses on `document.visibilityState === 'hidden'`
 * so a backgrounded tab does not keep a stream socket + heartbeat
 * alive. Resumes on visible (the underlying useEventSource
 * reconnects automatically with `Last-Event-ID` so no frames are
 * missed while paused — they just buffer server-side until the
 * next connection).
 *
 * Layout: header (breadcrumb + session goal + StatusPill) → ranked
 * hypotheses table (left) → decision log (right). Click a ranked
 * row to open a Sheet with that hypothesis's AI rank history (fed
 * from the same SSE stream; the server replays the last 200 events
 * on connect).
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { Sparkles } from "lucide-react";

import { useApi } from "@/lib/use-api";
import { useEventSource } from "@/lib/use-event-source";
import { Breadcrumb } from "@/shared/ui/breadcrumb";
import { Card, CardContent } from "@/shared/ui/card";
import { DataTable, type DataTableColumn } from "@/shared/ui/data-table";
import { EmptyState } from "@/shared/ui/empty-state";
import { ErrorState } from "@/shared/ui/error-state";
import { Sheet } from "@/shared/ui/sheet";
import { Skeleton } from "@/shared/ui/skeleton";
import { Badge } from "@/shared/ui/badge";
import { StatusPill } from "@/shared/ui/status-pill";
import type { StatusKey } from "@/shared/config/status";

import {
  AiRankHistory,
  type RankHistoryEntry,
} from "@/components/AiRankHistory";
import { DecisionLog, type DecisionLogEntry } from "@/components/DecisionLog";

// ---- wire types --------------------------------------------------------

interface RankedRow {
  readonly hypothesis_id: string;
  readonly title: string;
  readonly text: string;
  readonly ai_score: number | null;
  readonly rule_score: number | null;
  readonly score: number;
  readonly source: "ai" | "rule";
  readonly delta: number | null;
  readonly reasoning: string | null;
  readonly ai_rank_at: string | null;
  readonly ai_rank_event_id: string | null;
  /**
   * True when the row arrived via the live SSE stream AFTER the
   * GET snapshot — the title/text/rule_score are not yet known
   * for stream-only rows. Render with an `(unranked)` badge so
   * operators can distinguish "AI ranked a fresh hypothesis the
   * snapshot missed" from "the hypothesis title is genuinely empty".
   * The dedup invariant (see header) guarantees at most one
   * stream-only row per hypothesis per session.
   */
  readonly is_stream_only?: boolean;
}

interface AiReasoningResp {
  readonly session_id: string;
  readonly ranked: ReadonlyArray<RankedRow>;
  readonly decision_log: ReadonlyArray<DecisionLogEntry>;
}

interface SessionMeta {
  readonly id: string;
  readonly goal: string;
  readonly status: "active" | "paused" | "closed";
}

// Live SSE frames are full `EventRow` shapes (id + session_id +
// type + payload). The wire form of `hypothesis_ranked` matches
// `HypothesisRankedPayload` from `@cognit/db`.
interface SseEventRow {
  readonly id: string;
  readonly session_id: string;
  readonly type: string;
  readonly created_at?: string;
  readonly payload: {
    readonly hypothesis_id?: string;
    readonly score?: number;
    readonly reasoning?: string;
    readonly evaluator?: string;
  };
}

// ---- helpers -----------------------------------------------------------

const SESSION_STATUS_KEY: Record<SessionMeta["status"], StatusKey> = {
  active: "active",
  paused: "pending",
  closed: "archived",
};

const formatScore = (s: number | null): string =>
  s === null ? "—" : s.toFixed(2);

const formatDelta = (d: number | null): string => {
  if (d === null) return "—";
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(2)}`;
};

// ---- main page ---------------------------------------------------------

export const AiReasoningPage = (): JSX.Element => {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session") ?? "";

  // Pause SSE while the tab is backgrounded so we don't keep a
  // socket + heartbeat alive for an idle tab. The underlying
  // useEventSource reconnects with Last-Event-ID on resume so no
  // frames are missed — they buffer server-side until reconnect.
  const [tabVisible, setTabVisible] = useState<boolean>(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = (): void => setTabVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return (): void => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const aiPath = sessionId
    ? `/api/sessions/${sessionId}/ai-reasoning`
    : null;

  const ai = useApi<AiReasoningResp>(aiPath);
  const session = useApi<{ session: SessionMeta }>(
    sessionId ? `/api/sessions/${sessionId}` : null,
  );

  // Derive the highest ai_rank_event_id from the snapshot and pass
  // it as `?last_event_id=` so the SSE replay starts STRICTLY after
  // the snapshot. This is the server-side half of the dedup
  // invariant — combined with the client-side `snapshotIds` set in
  // `rankedByEvent`, every row is counted exactly once.
  const lastEventIdFromSnapshot = useMemo<string | null>(() => {
    const ranked = ai.data?.ranked ?? [];
    let max: string | null = null;
    for (const r of ranked) {
      const id = r.ai_rank_event_id;
      if (!id) continue;
      if (max === null || id.localeCompare(max) > 0) max = id;
    }
    return max;
  }, [ai.data]);

  const streamUrl = sessionId && tabVisible
    ? `/api/sessions/${sessionId}/ai-reasoning/stream${
        lastEventIdFromSnapshot ? `?last_event_id=${encodeURIComponent(lastEventIdFromSnapshot)}` : ""
      }`
    : null;

  const live = useEventSource<SseEventRow>(streamUrl);

  // Dedup live frames by event id so reconnects don't double-count.
  // `snapshotIds` is the set of event ids already accounted for by
  // the GET snapshot; the server only sends events strictly after
  // `lastEventIdFromSnapshot` so under normal operation
  // `snapshotIds.has(evId)` is always false here. The check stays
  // as a safety net for the rare case where the SSE replay window
  // overlaps the snapshot (server-side race, or operator scrolling
  // back through a long history).
  const rankedByEvent = useMemo<ReadonlyArray<RankedRow>>(() => {
    const base = ai.data?.ranked ?? [];
    const baseIds = new Set(base.map((r) => r.ai_rank_event_id).filter(Boolean));
    const fromStream: RankedRow[] = [];
    for (const f of live.events) {
      const data = f.data;
      if (!data || data.type !== "hypothesis_ranked") continue;
      const evId = data.id;
      if (baseIds.has(evId)) continue;
      const payload = data.payload ?? {};
      const hypId = payload.hypothesis_id;
      const score = payload.score;
      if (!hypId || typeof score !== "number" || !Number.isFinite(score)) continue;
      fromStream.push({
        hypothesis_id: hypId,
        title: "",
        text: "",
        ai_score: score,
        rule_score: null,
        score,
        source: "ai",
        delta: null,
        reasoning: payload.reasoning ?? null,
        ai_rank_at: data.created_at ?? null,
        ai_rank_event_id: evId,
        is_stream_only: true,
      });
      baseIds.add(evId);
    }
    return [...fromStream, ...base];
  }, [ai.data, live.events]);

  // Per-hypothesis rank history for the Sheet view. Keyed by
  // hypothesis id; accumulates from the SSE stream (newest first).
  const rankHistoryByHypothesis = useMemo<
    ReadonlyMap<string, ReadonlyArray<RankHistoryEntry>>
  >(() => {
    const m = new Map<string, RankHistoryEntry[]>();
    for (const f of live.events) {
      const data = f.data;
      if (!data || data.type !== "hypothesis_ranked") continue;
      const payload = data.payload ?? {};
      const hypId = payload.hypothesis_id;
      const score = payload.score;
      const reasoning = payload.reasoning ?? "";
      const evaluator = payload.evaluator ?? "ai-supervisor";
      if (!hypId || typeof score !== "number") continue;
      const entry: RankHistoryEntry = {
        event_id: data.id,
        created_at: data.created_at ?? "",
        score,
        reasoning,
        evaluator,
      };
      const arr = m.get(hypId);
      if (arr === undefined) m.set(hypId, [entry]);
      else arr.push(entry);
    }
    // Newest first per hypothesis.
    for (const arr of m.values()) {
      arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    return m;
  }, [live.events]);

  const [selectedHypothesisId, setSelectedHypothesisId] = useState<string | null>(
    null,
  );
  const selectedHypothesis = useMemo<RankedRow | null>(() => {
    if (!selectedHypothesisId) return null;
    return rankedByEvent.find((r) => r.hypothesis_id === selectedHypothesisId) ?? null;
  }, [rankedByEvent, selectedHypothesisId]);

  // Pulse a "updated" indicator in the Sheet when the open
  // hypothesis's rank history reorders (a new SSE frame arrived
  // while the Sheet is open). The memo key changes when the
  // newest-entry event_id changes; the indicator auto-clears after
  // 1.2s so it does not stay lit permanently.
  const selectedHistoryKey = useMemo<string>(() => {
    const entries =
      selectedHypothesisId !== null
        ? (rankHistoryByHypothesis.get(selectedHypothesisId) ?? [])
        : [];
    return entries.length > 0 ? entries[0]!.event_id : "";
  }, [rankHistoryByHypothesis, selectedHypothesisId]);
  const [historyUpdated, setHistoryUpdated] = useState<boolean>(false);
  useEffect(() => {
    if (!selectedHistoryKey) return;
    setHistoryUpdated(true);
    const tid = setTimeout(() => setHistoryUpdated(false), 1200);
    return (): void => clearTimeout(tid);
  }, [selectedHistoryKey]);

  const onRowClick = useCallback((row: RankedRow) => {
    setSelectedHypothesisId(row.hypothesis_id);
  }, []);

  // Reset selected row when session changes.
  useEffect(() => {
    setSelectedHypothesisId(null);
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="flex flex-col gap-3" data-testid="ai-reasoning-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "AI Reasoning" }]} />
        <EmptyState
          icon={Sparkles}
          title="No session selected"
          description="Open the AI Reasoning tab from a session timeline to inspect its supervisor activity."
        />
      </div>
    );
  }

  if (ai.loading && !ai.data) {
    return (
      <div className="flex flex-col gap-3" data-testid="ai-reasoning-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "AI Reasoning" }]} />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (ai.error) {
    return (
      <div className="flex flex-col gap-3" data-testid="ai-reasoning-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "AI Reasoning" }]} />
        <div data-testid="ai-reasoning-error">
          <ErrorState
            message={ai.error.message}
            onRetry={(): void => ai.refetch()}
          />
        </div>
      </div>
    );
  }

  const ranked = rankedByEvent;
  const decisionLog = ai.data?.decision_log ?? [];
  const sessionGoal = session.data?.session.goal ?? "";
  const sessionStatus = session.data?.session.status ?? null;

  const rankedColumns: ReadonlyArray<DataTableColumn<RankedRow>> = [
    {
      key: "title",
      header: "Hypothesis",
      render: (r) => (
        <div className="flex flex-col">
          <span className="flex items-center gap-2">
            <span className="font-medium">
              {r.title || r.text || r.hypothesis_id.slice(0, 12)}
            </span>
            {r.is_stream_only ? (
              <Badge
                variant="pending"
                data-testid="ai-reasoning-unranked"
              >
                (unranked)
              </Badge>
            ) : null}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {r.hypothesis_id.slice(0, 12)}…
          </span>
        </div>
      ),
    },
    {
      key: "ai_score",
      header: "AI",
      width: "5rem",
      render: (r) => (
        <span
          className="font-mono text-xs"
          data-testid="ai-reasoning-score"
        >
          {formatScore(r.ai_score)}
        </span>
      ),
    },
    {
      key: "rule_score",
      header: "Rule",
      width: "5rem",
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">
          {formatScore(r.rule_score)}
        </span>
      ),
    },
    {
      key: "delta",
      header: "Δ",
      width: "4rem",
      render: (r) => {
        const colour =
          r.delta === null
            ? "text-muted-foreground"
            : r.delta > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : r.delta < 0
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground";
        return (
          <span
            className={`font-mono text-xs ${colour}`}
            data-testid="ai-reasoning-delta"
          >
            {formatDelta(r.delta)}
          </span>
        );
      },
    },
    {
      key: "source",
      header: "Source",
      width: "5rem",
      render: (r) => (
        <Badge
          variant={r.source === "ai" ? "default" : "outline"}
          data-testid="ai-reasoning-source"
        >
          {r.source}
        </Badge>
      ),
    },
    {
      key: "reasoning",
      header: "Reasoning",
      render: (r) =>
        r.reasoning ? (
          <span
            className="block max-w-xs truncate text-xs text-muted-foreground"
            title={r.reasoning}
          >
            {r.reasoning}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="ai-reasoning-page">
      <div className="flex items-center justify-between">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "AI Reasoning" }]} />
        <div className="flex items-center gap-2">
          {sessionGoal ? (
            <span className="text-xs text-muted-foreground">{sessionGoal}</span>
          ) : null}
          {sessionStatus !== null ? (
            <StatusPill status={SESSION_STATUS_KEY[sessionStatus]} />
          ) : null}
        </div>
      </div>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Ranked hypotheses
        </h2>
        <Card>
          <CardContent className="p-0">
            <DataTable
              columns={rankedColumns}
              rows={ranked}
              rowKey={(r) => r.hypothesis_id + (r.ai_rank_event_id ?? "")}
              onRowClick={onRowClick}
              emptyMessage=""
            />
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Supervisor decision log
        </h2>
        <Card>
          <CardContent className="p-0">
            <DecisionLog entries={decisionLog} />
          </CardContent>
        </Card>
      </section>

      <Sheet
        open={selectedHypothesis !== null}
        onClose={(): void => setSelectedHypothesisId(null)}
        title={selectedHypothesis?.title || selectedHypothesis?.hypothesis_id.slice(0, 12) || "AI rank history"}
        description={`AI rank history · hypothesis ${selectedHypothesis?.hypothesis_id.slice(0, 12) ?? ""}…`}
        width="md"
        data-testid="ai-reasoning-history-sheet"
      >
        {selectedHypothesis ? (
          <div className="flex flex-col gap-3">
            <div>
              <div className="flex items-center gap-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Current score
                </div>
                {historyUpdated ? (
                  <Badge
                    variant="active"
                    className="animate-pulse"
                    data-testid="ai-reasoning-history-updated"
                  >
                    updated
                  </Badge>
                ) : null}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-sm">
                  AI {formatScore(selectedHypothesis.ai_score)}
                </span>
                <span className="text-xs text-muted-foreground">
                  Rule {formatScore(selectedHypothesis.rule_score)}
                </span>
                <Badge variant={selectedHypothesis.source === "ai" ? "default" : "outline"}>
                  {selectedHypothesis.source}
                </Badge>
              </div>
            </div>
            <AiRankHistory
              entries={
                rankHistoryByHypothesis.get(selectedHypothesis.hypothesis_id) ?? []
              }
            />
          </div>
        ) : null}
      </Sheet>
    </div>
  );
};
