/**
 * apps/dashboard/src/shared/ui/status-pill.tsx — status pill.
 *
 * Composes Badge + lucide icon via the status config map.
 */
import { statusMeta, type StatusKey } from "../config/status";
import { cn } from "../lib/cn";

export interface StatusPillProps {
  readonly status: StatusKey;
  readonly label?: string;
  readonly className?: string;
  readonly "data-testid"?: string;
}

export const StatusPill = ({
  status,
  label,
  className,
  "data-testid": testId,
}: StatusPillProps) => {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        meta.bg,
        meta.fg,
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {label ?? meta.label}
    </span>
  );
};
