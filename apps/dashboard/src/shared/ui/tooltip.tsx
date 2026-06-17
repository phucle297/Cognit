/**
 * apps/dashboard/src/shared/ui/tooltip.tsx — Radix Tooltip wrapper.
 *
 * FSD layer: shared.
 */
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { cn } from "../lib/cn";

export const TooltipProvider = RadixTooltip.Provider;
export const Tooltip = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;

export const TooltipContent = forwardRef<
  ElementRef<typeof RadixTooltip.Content>,
  ComponentPropsWithoutRef<typeof RadixTooltip.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <RadixTooltip.Portal>
    <RadixTooltip.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow",
        className,
      )}
      {...props}
    />
  </RadixTooltip.Portal>
));
TooltipContent.displayName = "TooltipContent";
