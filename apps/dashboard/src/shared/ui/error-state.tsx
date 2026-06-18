/**
 * apps/dashboard/src/shared/ui/error-state.tsx — error placeholder.
 */
import { AlertCircle } from "lucide-react";
import { Button } from "./button";
import { cn } from "../lib/cn";

export interface ErrorStateProps {
  readonly message: string;
  readonly onRetry?: () => void;
  readonly className?: string;
}

export const ErrorState = ({ message, onRetry, className }: ErrorStateProps) => (
  <div
    className={cn(
      "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-destructive/30 bg-card px-6 py-12 text-center",
      className,
    )}
  >
    <AlertCircle className="size-10 text-destructive" aria-hidden />
    <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
    {onRetry ? (
      <Button variant="subtle" onClick={onRetry}>
        Retry
      </Button>
    ) : null}
  </div>
);
