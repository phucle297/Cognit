/**
 * apps/dashboard/src/components/TimelineList.tsx
 *
 * FSD layer: components. Vertical list of EventRow items. The
 * container has a stable test id so the Timeline test can count
 * rows without coupling to internal layout.
 */
import type { JSX } from "react";
import { EventRow, type EventRowShape } from "./EventRow";

export type TimelineListProps = {
  events: ReadonlyArray<EventRowShape>;
};

export const TimelineList = ({ events }: TimelineListProps): JSX.Element => {
  if (events.length === 0) {
    return (
      <div
        data-testid="timeline-empty"
        className="px-3 py-8 text-center text-sm text-muted-foreground"
      >
        No events match the current filters.
      </div>
    );
  }
  return (
    <div data-testid="timeline-list" role="list" className="overflow-hidden rounded-md border border-border">
      {events.map((e) => (
        <div role="listitem" key={e.id}>
          <EventRow event={e} />
        </div>
      ))}
    </div>
  );
};
