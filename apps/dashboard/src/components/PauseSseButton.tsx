/**
 * apps/dashboard/src/components/PauseSseButton.tsx
 *
 * FSD layer: components. Toggle that pauses/resumes the live
 * SSE stream on the Timeline page. The page owns the
 * useEventSource hook; PauseSseButton just flips the boolean
 * and shows the resulting connection status.
 */
import type { JSX } from "react";
import { Button } from "@/shared/ui/button";
import type { SseStatus } from "@/lib/use-event-source";

export type PauseSseButtonProps = {
  paused: boolean;
  onToggle: () => void;
  status: SseStatus;
};

export const PauseSseButton = ({ paused, onToggle, status }: PauseSseButtonProps): JSX.Element => {
  const label = paused ? "Resume SSE" : "Pause SSE";
  return (
    <div className="flex items-center gap-2">
      <span
        data-testid="sse-status"
        data-status={status}
        className="text-xs font-mono text-muted-foreground"
      >
        status: {status}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="pause-sse-button"
        onClick={onToggle}
      >
        {label}
      </Button>
    </div>
  );
};
