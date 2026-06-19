/**
 * apps/dashboard/src/shared/ui/empty-state.tsx — empty list state.
 */
import type { LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

export const EmptyState = ({
  icon: Icon,
  title,
  description,
  action,
  className,
  ...rest
}: EmptyStateProps) => (
  <div
    {...rest}
    className={cn(
      "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card px-6 py-12 text-center",
      className,
    )}
  >
    <Icon className="size-10 text-muted-foreground" aria-hidden />
    <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
    {description ? (
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
    ) : null}
    {action ? <div className="mt-2">{action}</div> : null}
  </div>
);
