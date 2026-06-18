/**
 * apps/dashboard/src/shared/ui/stat-card.tsx — KPI tile.
 */
import type { LucideIcon } from "lucide-react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "../lib/cn";

export interface StatCardProps {
  readonly label: string;
  readonly value: string | number;
  readonly delta?: number;
  readonly icon?: LucideIcon;
  readonly className?: string;
}

export const StatCard = ({ label, value, delta, icon: Icon, className }: StatCardProps) => {
  const positive = delta !== undefined && delta >= 0;
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card p-6 shadow-[var(--shadow-sm)]",
        className,
      )}
    >
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{label}</span>
        {Icon ? <Icon className="size-4" aria-hidden /> : null}
      </div>
      <div className="text-3xl font-semibold tracking-tight">{value}</div>
      {delta !== undefined ? (
        <div
          className={cn(
            "flex items-center gap-1 text-xs font-medium",
            positive ? "text-[var(--color-status-active)]" : "text-[var(--color-status-failed)]",
          )}
        >
          {positive ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
          {positive ? `+${delta}` : `${delta}`}
          <span className="text-muted-foreground">vs last week</span>
        </div>
      ) : null}
    </div>
  );
};
