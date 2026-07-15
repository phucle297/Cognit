/**
 * apps/dashboard/src/pages/timeline.tsx — Timeline (6.8.2.P4).
 *
 * FSD layer: pages. Sticky header (session goal + StatusPill +
 * breadcrumb). Filters: type multi-select, actor multi-select,
 * date range. DataTable (time mono, type Badge, actor, summary,
 * expand caret). Row click → side Sheet with full event payload.
 * EmptyState on no-match.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { Activity, ChevronRight, HelpCircle, Search, X } from "lucide-react";

import { useApi } from "@/lib/use-api";
import { useEventSource } from "@/lib/use-event-source";
import { Badge } from "@/shared/ui/badge";
import { Breadcrumb } from "@/shared/ui/breadcrumb";
import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";
import { DataTable, type DataTableColumn } from "@/shared/ui/data-table";
import { EmptyState } from "@/shared/ui/empty-state";
import { ErrorState } from "@/shared/ui/error-state";
import { Input } from "@/shared/ui/input";
import { Sheet } from "@/shared/ui/sheet";
import { Skeleton } from "@/shared/ui/skeleton";
import { StatusPill } from "@/shared/ui/status-pill";
import type { StatusKey } from "@/shared/config/status";
import { PauseSseButton } from "@/components/PauseSseButton";
import type { EventRowShape } from "@/components/EventRow";
import { normalizeEvent, normalizeEvents } from "@/lib/normalize-event";
import { formatIso, formatPayloadSummary, formatUlid } from "@/lib/format";
import {
  RejectionSheet,
  type RejectionSummary,
} from "@/widgets/rejection-sheet";

export type EventsResp = {
  events: ReadonlyArray<EventRowShape>;
};

type SessionMeta = {
  readonly id: string;
  readonly goal: string;
  readonly status: "active" | "paused" | "closed";
};

type SessionResp = { readonly session: SessionMeta };

const ACTOR_DEBOUNCE_MS = 250;

const SESSION_STATUS_KEY: Record<SessionMeta["status"], StatusKey> = {
  active: "active",
  paused: "pending",
  closed: "archived",
};

export const TimelinePage = (): JSX.Element => {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session");

  const [paused, setPaused] = useState<boolean>(false);
  const streamUrl = paused || !sessionId ? null : "/api/events/stream";
  const live = useEventSource<EventRowShape>(streamUrl);

  const initialPath = sessionId ? `/api/sessions/${sessionId}/events?limit=50` : null;
  const initial = useApi<EventsResp>(initialPath);
  const session = useApi<SessionResp>(sessionId ? `/api/sessions/${sessionId}` : null);

  const [initialEvents, setInitialEvents] = useState<ReadonlyArray<EventRowShape>>([]);
  useEffect(() => {
    if (initial.data?.events) {
      // API returns raw DB rows; map to UI shape (kind/ts/payload/actor).
      setInitialEvents([...normalizeEvents(initial.data.events)].reverse());
    }
  }, [initial.data]);

  const liveForSession = useMemo<ReadonlyArray<EventRowShape>>(() => {
    if (!sessionId) return [];
    return live.events
      .map((e) => normalizeEvent(e.data))
      .filter((d): d is EventRowShape => d !== null)
      .filter((d) => d.session_id === sessionId);
  }, [live.events, sessionId]);

  const allEvents = useMemo<ReadonlyArray<EventRowShape>>(
    () => [...initialEvents, ...liveForSession],
    [initialEvents, liveForSession],
  );

  const [selectedKinds, setSelectedKinds] = useState<ReadonlyArray<string>>(() => {
    // Phase B.4: `/timeline?kind=verification_*` seeds the kind
    // filter from the URL so the verification view is one click
    // away. `verification_*` is a glob — match against any kind
    // that starts with `verification_` (handles
    // `verification_started`, `verification_passed`, etc.).
    const raw = searchParams.get("kind");
    if (raw === null || raw.length === 0) return [];
    return [raw];
  });
  const [actorInput, setActorInput] = useState<string>("");
  const [debouncedActor, setDebouncedActor] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedActor(actorInput), ACTOR_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [actorInput]);

  const distinctKinds = useMemo<ReadonlyArray<string>>(() => {
    const s = new Set<string>();
    for (const e of allEvents) s.add(e.kind);
    return Array.from(s).sort();
  }, [allEvents]);

  const distinctActors = useMemo<ReadonlyArray<string>>(() => {
    const s = new Set<string>();
    for (const e of allEvents) if (e.actor) s.add(e.actor);
    return Array.from(s).sort();
  }, [allEvents]);

  const [selectedActors, setSelectedActors] = useState<ReadonlyArray<string>>([]);

  const filtered = useMemo<ReadonlyArray<EventRowShape>>(() => {
    const actorLower = debouncedActor.trim().toLowerCase();
    const fromMs = dateFrom ? new Date(dateFrom).getTime() : null;
    const toMs = dateTo ? new Date(dateTo).getTime() + 86_400_000 : null;
    // A `selectedKinds` entry that ends with `_*` is a glob. The
    // phase B.4 URL flag `?kind=verification_*` matches every
    // verification lifecycle event in one chip.
    const matchesKind = (kind: string): boolean => {
      if (selectedKinds.length === 0) return true;
      for (const k of selectedKinds) {
        if (k.endsWith("_*")) {
          if (kind.startsWith(k.slice(0, -2))) return true;
        } else if (k === kind) {
          return true;
        }
      }
      return false;
    };
    return allEvents.filter((e) => {
      if (!matchesKind(e.kind)) return false;
      if (selectedActors.length > 0 && !selectedActors.includes(e.actor ?? "")) return false;
      if (actorLower.length > 0 && !(e.actor ?? "").toLowerCase().includes(actorLower)) return false;
      if (fromMs !== null || toMs !== null) {
        const t = new Date(e.ts).getTime();
        if (Number.isNaN(t)) return false;
        if (fromMs !== null && t < fromMs) return false;
        if (toMs !== null && t > toMs) return false;
      }
      return true;
    });
  }, [allEvents, selectedKinds, selectedActors, debouncedActor, dateFrom, dateTo]);

  const [selectedEvent, setSelectedEvent] = useState<EventRowShape | null>(null);
  const [fullEvent, setFullEvent] = useState<unknown>(null);
  // Phase B.4 row action: "Why was this rejected?" opens a side
  // sheet with supporting observations, contradicting observations,
  // the linked check, the AI rank history sparkline, and a
  // "Resume this investigation" button.
  const [rejection, setRejection] = useState<RejectionSummary | null>(null);
  useEffect(() => {
    if (!selectedEvent) {
      setFullEvent(null);
      return;
    }
    // Prefer the already-normalized row payload (list endpoint has full
    // payload_json). Optional GET /api/events/:id is not implemented yet.
    setFullEvent({
      id: selectedEvent.id,
      kind: selectedEvent.kind,
      session_id: selectedEvent.session_id,
      actor: selectedEvent.actor,
      ts: selectedEvent.ts,
      payload: selectedEvent.payload,
    });
  }, [selectedEvent]);

  if (!sessionId) {
    return (
      <div className="flex flex-col gap-4" data-testid="timeline-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Timeline" }]} />
        <EmptyState
          icon={Activity}
          title="No session selected"
          description="Open a session from the Overview page to view its timeline."
        />
      </div>
    );
  }

  if (initial.loading && allEvents.length === 0) {
    return (
      <div className="flex flex-col gap-4" data-testid="timeline-page">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (initial.error) {
    return (
      <ErrorState
        message={initial.error.api.message}
        onRetry={(): void => initial.refetch()}
        data-testid="timeline-error"
      />
    );
  }

  const sessionMeta = session.data?.session;
  const goal = sessionMeta?.goal ?? "Timeline";

  const columns: ReadonlyArray<DataTableColumn<EventRowShape>> = [
    {
      key: "ts",
      header: "Time",
      width: "13rem",
      render: (e) => <span className="font-mono text-xs">{formatIso(e.ts)}</span>,
    },
    {
      key: "kind",
      header: "Type",
      width: "16rem",
      render: (e) => (
        <Badge variant="neutral" data-testid="timeline-event-kind">
          {e.kind}
        </Badge>
      ),
    },
    {
      key: "actor",
      header: "Actor",
      width: "8rem",
      render: (e) => <span className="text-sm">{e.actor || "—"}</span>,
    },
    {
      key: "summary",
      header: "Summary",
      render: (e) => <span className="text-sm text-muted-foreground">{formatPayloadSummary(e.payload)}</span>,
    },
    {
      // Phase B.4 row action — only `hypothesis_rejected` rows get
      // a "Why was this rejected?" button. The button extracts the
      // rejection summary from the row's payload (matches the wire
      // shape of `HypothesisRejectedPayload`) and opens the shared
      // RejectionSheet.
      key: "why",
      header: "",
      width: "3.5rem",
      render: (e) =>
        e.kind === "hypothesis_rejected" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={(ev): void => {
              ev.stopPropagation();
              const p = (e.payload ?? {}) as {
                reason_type?: RejectionSummary["reason_type"];
                superseded_by_id?: string | null;
                hypothesis_id?: string;
                title?: string;
                text?: string;
                reason?: string;
              };
              const textSummary = formatPayloadSummary(e.payload);
              setRejection({
                hypothesis_id: p.hypothesis_id ?? e.id,
                title: p.title ?? textSummary,
                text: p.text ?? textSummary,
                reason_type: p.reason_type ?? null,
                reason: p.reason ?? textSummary,
                superseded_by_id: p.superseded_by_id ?? null,
                created_at: e.ts,
              });
            }}
            data-testid="timeline-why-rejected"
            aria-label="Why was this rejected?"
          >
            <HelpCircle className="size-3.5" aria-hidden />
          </Button>
        ) : null,
    },
    {
      key: "expand",
      header: "",
      width: "3rem",
      render: () => <ChevronRight className="size-4 text-muted-foreground" aria-hidden />,
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="timeline-page">
      <div className="sticky top-0 z-20 -mx-[var(--space-page-x)] flex flex-col gap-2 border-b bg-background/95 px-[var(--space-page-x)] py-3 backdrop-blur">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: goal }]} />
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-xl font-semibold tracking-tight">{goal}</h1>
            {sessionMeta ? <StatusPill status={SESSION_STATUS_KEY[sessionMeta.status]} /> : null}
          </div>
          <PauseSseButton
            paused={paused}
            onToggle={(): void => setPaused((p) => !p)}
            status={paused ? "closed" : live.status}
          />
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Type</span>
              <div className="flex flex-wrap gap-1">
                {distinctKinds.length === 0 ? (
                  <span className="text-xs text-muted-foreground">no events yet</span>
                ) : (
                  distinctKinds.map((k) => {
                    const on = selectedKinds.includes(k);
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={(): void =>
                          setSelectedKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))
                        }
                        data-testid={`timeline-kind-${k}`}
                        data-on={on}
                        className={
                          on
                            ? "rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground"
                            : "rounded-full border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                        }
                      >
                        {k}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Actor</span>
            <div className="flex flex-wrap gap-1">
              {distinctActors.length === 0 ? (
                <span className="text-xs text-muted-foreground">no actors</span>
              ) : (
                distinctActors.map((a) => {
                  const on = selectedActors.includes(a);
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={(): void =>
                        setSelectedActors((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]))
                      }
                      data-testid={`timeline-actor-${a}`}
                      data-on={on}
                      className={
                        on
                          ? "rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground"
                          : "rounded-full border bg-card px-2.5 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                      }
                    >
                      {a}
                    </button>
                  );
                })
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Search className="size-3.5 text-muted-foreground" aria-hidden />
              <Input
                placeholder="Actor contains…"
                value={actorInput}
                onChange={(e): void => setActorInput(e.target.value)}
                className="h-8 w-48"
                data-testid="timeline-actor-input"
              />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              From
              <Input
                type="date"
                value={dateFrom}
                onChange={(e): void => setDateFrom(e.target.value)}
                className="h-8 w-40"
                data-testid="timeline-date-from"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              To
              <Input
                type="date"
                value={dateTo}
                onChange={(e): void => setDateTo(e.target.value)}
                className="h-8 w-40"
                data-testid="timeline-date-to"
              />
            </label>
            {dateFrom || dateTo || selectedKinds.length > 0 || selectedActors.length > 0 || actorInput ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={(): void => {
                  setSelectedKinds([]);
                  setSelectedActors([]);
                  setActorInput("");
                  setDateFrom("");
                  setDateTo("");
                }}
                data-testid="timeline-clear-filters"
              >
                <X className="size-3.5" aria-hidden /> Clear
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No matching events"
          description="Try clearing a filter or selecting a different session."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataTable
              columns={columns}
              rows={filtered}
              rowKey={(e) => e.id}
              onRowClick={setSelectedEvent}
              emptyMessage=""
            />
          </CardContent>
        </Card>
      )}

      <Sheet
        open={selectedEvent !== null}
        onClose={(): void => setSelectedEvent(null)}
        title={selectedEvent?.kind ?? "Event"}
        description={selectedEvent ? `id ${formatUlid(selectedEvent.id)}` : undefined}
        width="md"
        data-testid="timeline-event-sheet"
      >
        {selectedEvent ? (
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">When</div>
              <div className="font-mono text-xs">{formatIso(selectedEvent.ts)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Actor</div>
              <div>{selectedEvent.actor || "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Payload</div>
              <pre
                data-testid="timeline-event-payload"
                className="mt-1 max-h-96 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs"
              >
                {fullEvent ? JSON.stringify(fullEvent, null, 2) : "Loading…"}
              </pre>
            </div>
          </div>
        ) : null}
      </Sheet>

      <RejectionSheet
        open={rejection !== null}
        onClose={(): void => setRejection(null)}
        sessionId={sessionId ?? ""}
        summary={rejection}
      />
    </div>
  );
};
