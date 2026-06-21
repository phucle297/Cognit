/**
 * apps/dashboard/src/shared/ui/stat-card.tsx — KPI tile.
 *
 * Restyled to match the Alina KPI card pattern: brand-color
 * icon chip on the left, label, large value, optional delta +
 * trend hint. Optional `subtitle` slot for a secondary metric
 * (e.g. "of 120 total"). Light theme via tokens.
 */
import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "../lib/cn";

export interface StatCardProps {
  readonly label: string;
  readonly value: string | number;
  readonly delta?: number;
  readonly icon?: LucideIcon;
  /** Optional secondary metric shown under the value. */
  readonly subtitle?: string;
  readonly className?: string;
  /** Apply the staggered fade-in animation. Pass the 0-based index
   *  so the card slides in after its siblings. */
  readonly staggerIndex?: number;
}

export const StatCard = ({
  label,
  value,
  delta,
  icon: Icon,
  subtitle,
  className,
  staggerIndex,
}: StatCardProps) => {
  const positive = delta !== undefined && delta >= 0;
  return (
    <div
      data-testid="stat-card"
      style={staggerIndex !== undefined ? ({ "--stagger-index": staggerIndex } as CSSProperties) : undefined}
      className={cn(
        "flex min-h-[var(--space-kpi-min-h)] flex-col gap-3 rounded-lg bg-card p-5 shadow-[var(--shadow)]",
        "transition-[box-shadow,transform] duration-[var(--duration-base)] ease-[var(--ease-out)]",
        "hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]",
        staggerIndex !== undefined && "stagger-item",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {Icon ? (
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-md bg-[var(--color-brand-bg)] text-[var(--color-brand)]"
          >
            <Icon className="size-4" />
          </span>
        ) : null}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tracking-tight tabular-nums">{value}</span>
        {subtitle !== undefined ? (
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        ) : null}
      </div>
      {delta !== undefined ? (
        <div
          className={cn(
            "flex items-center gap-1 text-xs font-medium",
            positive ? "text-[var(--color-status-active)]" : "text-[var(--color-status-failed)]",
          )}
        >
          {positive ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
          <span className="tabular-nums">{positive ? `+${delta}` : `${delta}`}</span>
          <span className="font-normal text-muted-foreground">vs last week</span>
        </div>
      ) : null}
    </div>
  );
};
