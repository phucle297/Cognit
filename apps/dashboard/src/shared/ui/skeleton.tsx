/**
 * apps/dashboard/src/shared/ui/skeleton.tsx — loading placeholder.
 */
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

const skeletonVariants = cva("animate-pulse rounded-md bg-muted", {
  variants: {
    variant: {
      rect: "",
      text: "h-4 w-full",
      circle: "rounded-full",
    },
  },
  defaultVariants: { variant: "rect" },
});

export type SkeletonProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof skeletonVariants>;

export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(skeletonVariants({ variant }), className)}
      {...props}
    />
  ),
);
Skeleton.displayName = "Skeleton";
