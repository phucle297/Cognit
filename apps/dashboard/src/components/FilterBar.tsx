/**
 * apps/dashboard/src/components/FilterBar.tsx
 *
 * FSD layer: components. Filter controls for the Timeline page.
 *
 *  - Type chip toggles (multi-select). The AC requires at least
 *    one "type chip" filter; the chip set is built from the
 *    kinds seen across the loaded + live events so it grows as
 *    the stream expands.
 *  - Actor debounced input. The page owns the debounced value
 *    (250ms) — FilterBar exposes the raw text via onActorChange
 *    and a separate debounced via onActorDebounced. The 250ms
 *    timer is implemented at the page level (TimelinePage) so
 *    that the filter logic stays co-located with state; this
 *    component is purely presentational.
 */
import { useId, type ChangeEvent, type JSX } from "react";
import { Badge } from "@/shared/ui/badge";
import { Input } from "@/shared/ui/input";

export type FilterBarProps = {
  /** All distinct event kinds currently visible in the stream. */
  kinds: ReadonlyArray<string>;
  /** Selected type chips. Empty array = no filter. */
  selectedKinds: ReadonlyArray<string>;
  onToggleKind: (kind: string) => void;
  /** Current raw input value (controlled). */
  actorInput: string;
  /** Fires on every keystroke. */
  onActorChange: (next: string) => void;
};

export const FilterBar = ({
  kinds,
  selectedKinds,
  onToggleKind,
  actorInput,
  onActorChange,
}: FilterBarProps): JSX.Element => {
  const actorId = useId();
  return (
    <div
      data-testid="timeline-filter-bar"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Type</span>
        {kinds.length === 0 ? (
          <span className="text-xs text-muted-foreground">no events yet</span>
        ) : (
          kinds.map((kind) => {
            const active = selectedKinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                role="switch"
                aria-checked={active}
                data-testid={`type-chip-${kind}`}
                onClick={(): void => onToggleKind(kind)}
                className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
              >
                <Badge variant={active ? "default" : "outline"}>{kind}</Badge>
              </button>
            );
          })
        )}
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={actorId} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Actor
        </label>
        <Input
          id={actorId}
          data-testid="actor-input"
          placeholder="filter by actor…"
          value={actorInput}
          onChange={(e: ChangeEvent<HTMLInputElement>): void => onActorChange(e.target.value)}
          className="max-w-xs"
        />
      </div>
    </div>
  );
};
