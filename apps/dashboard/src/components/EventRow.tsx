/**
 * apps/dashboard/src/components/EventRow.tsx
 *
 * FSD layer: components (page-level composition shared by the
 * Timeline page). Renders a single event as a row: ULID, ISO
 * timestamp, event type, actor, payload preview. Stable `key`
 * on the parent is the event id, so the row must not remount
 * when the list grows.
 */
import type { JSX } from "react";
import { Badge } from "@/shared/ui/badge";
import { formatIso, formatPayloadSummary, formatUlid } from "@/lib/format";

export type EventRowShape = {
  id: string;
  kind: string;
  session_id: string;
  actor: string;
  ts: string;
  payload: unknown;
};

export type EventRowProps = {
  event: EventRowShape;
};

export const EventRow = ({ event }: EventRowProps): JSX.Element => {
  return (
    <div
      data-testid="timeline-event-row"
      data-event-id={event.id}
      className="grid grid-cols-[10rem_8rem_minmax(0,1fr)_minmax(0,2fr)] items-center gap-3 border-b border-border/60 px-3 py-2 text-sm"
    >
      <span className="font-mono text-xs text-muted-foreground">{formatUlid(event.id)}</span>
      <span className="font-mono text-xs text-muted-foreground">{formatIso(event.ts)}</span>
      <span>
        <Badge variant="outline" data-testid="event-kind">
          {event.kind}
        </Badge>
      </span>
      <span className="truncate text-muted-foreground">
        <span className="mr-2 font-medium text-foreground">{event.actor || "—"}</span>
        <span className="text-xs">{formatPayloadSummary(event.payload)}</span>
      </span>
    </div>
  );
};
