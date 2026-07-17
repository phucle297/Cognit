/**
 * apps/dashboard/src/shared/ui/card.tsx — card primitives.
 *
 * FSD layer: shared. shadcn copy. Composable sections so a page
 * can render a header / body / footer inside a single card.
 */
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

const cardVariants = cva(
  "rounded-[var(--radius-lg)] text-card-foreground transition-[box-shadow,transform] duration-[var(--duration-base)] ease-[var(--ease-out)]",
  {
    variants: {
      variant: {
        // Borderless by default — shadow alone separates the card
        // from the page. Less visual noise than a 1px line.
        default: "bg-card shadow-[var(--shadow)]",
        elevated: "bg-card shadow-[var(--shadow-md)]",
        // Opt-in for surfaces that genuinely need a hard edge
        // (e.g. inputs inside a card, dialog body on tinted bg).
        outlined: "border border-border bg-card",
        // Interactive: lifts on hover with a slightly deeper
        // shadow. Use on clickable cards (project tiles, KPIs).
        interactive:
          "bg-card shadow-[var(--shadow)] hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]",
        flat: "bg-card",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type CardProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof cardVariants>;

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(cardVariants({ variant }), className)}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
  ),
);
CardHeader.displayName = "CardHeader";

export const CardTitle = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />
  ),
);
CardTitle.displayName = "CardTitle";

export const CardDescription = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  ),
);
CardDescription.displayName = "CardDescription";

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  ),
);
CardContent.displayName = "CardContent";

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
  ),
);
CardFooter.displayName = "CardFooter";
