/**
 * apps/dashboard/src/shared/ui/badge.tsx — Badge primitive.
 *
 * shadcn-style. Variants: neutral (default) + 5 status colors
 * (active/pending/failed/verified/archived) + outline.
 */
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground",
        neutral: "bg-muted text-muted-foreground",
        outline: "border text-foreground",
        active:
          "bg-[var(--color-status-active-bg)] text-[var(--color-status-active)]",
        pending:
          "bg-[var(--color-status-pending-bg)] text-[var(--color-status-pending)]",
        failed:
          "bg-[var(--color-status-failed-bg)] text-[var(--color-status-failed)]",
        verified:
          "bg-[var(--color-status-verified-bg)] text-[var(--color-status-verified)]",
        archived:
          "bg-[var(--color-status-archived-bg)] text-[var(--color-status-archived)]",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  ),
);
Badge.displayName = "Badge";

export { badgeVariants };
