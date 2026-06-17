/**
 * apps/dashboard/src/pages/timeline.tsx — Timeline page (6.3).
 *
 * FSD layer: pages. Binds the Timeline UI to a session id
 * carried in the URL search params (`?session=<ulid>`). Loads
 * the initial 50 events via useApi, then appends live SSE
 * events from `/events/stream` filtered by session_id.
 *
 * Filter model:
 *  - type chips: Set<string> of selected kinds (multi-select).
 *    When empty, no kind filter is applied.
 *  - actor: free-text input. The page debounces 250ms before
 *    promoting the raw input into `debouncedActor`, which is
 *    what actually drives the filter.
 *
 * SSE control:
 *  - When `paused` is true the page passes `null` to
 *    useEventSource so the underlying EventSource closes. The
 *    status reported by the hook reflects "closed" in that case.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "@/lib/use-api";
import { useEventSource } from "@/lib/use-event-source";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { FilterBar } from "../components/FilterBar";
import { PauseSseButton } from "../components/PauseSseButton";
import { TimelineList } from "../components/TimelineList";
import type { EventRowShape } from "../components/EventRow";

export type EventsResp = {
  events: ReadonlyArray<EventRowShape>;
};

const ACTOR_DEBOUNCE_MS = 250;

export const TimelinePage = (): JSX.Element => {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session");

  // SSE live state.
  const [paused, setPaused] = useState<boolean>(false);
  const streamUrl = paused || !sessionId ? null : "/events/stream";
  const live = useEventSource<EventRowShape>(streamUrl);

  // Initial 50 events from the REST endpoint.
  const initialPath = sessionId ? `/sessions/${sessionId}/events?limit=50` : null;
  const initial = useApi<EventsResp>(initialPath);

  // Merged list. Initial GET returns newest 50 — reverse for
  // display so the latest event is at the bottom (live events
  // append at the tail).
  const [initialEvents, setInitialEvents] = useState<ReadonlyArray<EventRowShape>>([]);

  useEffect(() => {
    if (initial.data?.events) {
      // The REST endpoint already returns newest-first; we
      // render top-down so reverse for ascending display.
      setInitialEvents([...initial.data.events].reverse());
    }
  }, [initial.data]);

  // Live events filtered by session id and merged with initial.
  const liveForSession = useMemo<ReadonlyArray<EventRowShape>>(() => {
    if (!sessionId) return [];
    return live.events
      .map((e) => e.data)
      .filter((d): d is EventRowShape => Boolean(d && typeof d === "object" && "id" in d))
      .filter((d) => d.session_id === sessionId);
  }, [live.events, sessionId]);

  const allEvents = useMemo<ReadonlyArray<EventRowShape>>(() => {
    return [...initialEvents, ...liveForSession];
  }, [initialEvents, liveForSession]);

  // Filter state — type chips.
  const [selectedKinds, setSelectedKinds] = useState<ReadonlyArray<string>>([]);

  // Filter state — actor input + 250ms debounce.
  const [actorInput, setActorInput] = useState<string>("");
  const [debouncedActor, setDebouncedActor] = useState<string>("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedActor(actorInput);
    }, ACTOR_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [actorInput]);

  // Distinct kinds for chip rendering, derived from the
  // currently-loaded events (initial + live).
  const kinds = useMemo<ReadonlyArray<string>>(() => {
    const set = new Set<string>();
    for (const e of allEvents) set.add(e.kind);
    return Array.from(set).sort();
  }, [allEvents]);

  // Apply filters.
  const filtered = useMemo<ReadonlyArray<EventRowShape>>(() => {
    const actorLower = debouncedActor.trim().toLowerCase();
    return allEvents.filter((e) => {
      if (selectedKinds.length > 0 && !selectedKinds.includes(e.kind)) return false;
      if (actorLower.length > 0 && !(e.actor ?? "").toLowerCase().includes(actorLower)) return false;
      return true;
    });
  }, [allEvents, selectedKinds, debouncedActor]);

  if (!sessionId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="timeline-empty-session" className="text-sm text-muted-foreground">
            Open a session to view its timeline.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div data-testid="timeline-page" className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Timeline</h1>
        <PauseSseButton
          paused={paused}
          onToggle={(): void => setPaused((p) => !p)}
          status={paused ? "closed" : live.status}
        />
      </div>
      <FilterBar
        kinds={kinds}
        selectedKinds={selectedKinds}
        onToggleKind={(kind): void =>
          setSelectedKinds((prev) =>
            prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
          )
        }
        actorInput={actorInput}
        onActorChange={setActorInput}
      />
      {initial.loading && allEvents.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading events…</p>
      ) : null}
      {initial.error ? (
        <p data-testid="timeline-error" className="text-sm text-destructive">
          {initial.error.api.message}
        </p>
      ) : null}
      <TimelineList events={filtered} />
    </div>
  );
};
