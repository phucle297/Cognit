/**
 * apps/dashboard/src/shared/ui/accordion.tsx — single-row accordion.
 *
 * FSD layer: shared. Headless disclosure: click to expand a
 * single inline panel. No external dep. Used by the
 * Verification page for stdout/stderr/linked-hypothesis
 * expansion. The component is `single` mode only — multi-row
 * accordions can land in a later phase.
 *
 * Token-driven: motion uses --duration-slow + --ease-out per
 * spec AC #3.
 */
import { useState, type JSX, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";

export interface AccordionItem {
  readonly id: string;
  readonly trigger: ReactNode;
  readonly content: ReactNode;
}

export interface AccordionProps {
  readonly items: ReadonlyArray<AccordionItem>;
  readonly defaultOpenId?: string | undefined;
  readonly className?: string | undefined;
}

export const Accordion = ({
  items,
  defaultOpenId,
  className,
}: AccordionProps): JSX.Element => {
  const [openId, setOpenId] = useState<string | null>(defaultOpenId ?? null);
  return (
    <div className={cn("flex flex-col gap-1", className)} data-testid="accordion">
      {items.map((item) => {
        const open = openId === item.id;
        return (
          <div
            key={item.id}
            data-testid="accordion-item"
            data-open={open}
            className="overflow-hidden rounded-md border bg-card"
          >
            <button
              type="button"
              data-testid="accordion-trigger"
              aria-expanded={open}
              onClick={(): void => setOpenId(open ? null : item.id)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-muted/50"
            >
              <span className="min-w-0 truncate">{item.trigger}</span>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform duration-[var(--duration-slow)] ease-[var(--ease-out)]",
                  open ? "rotate-180" : "rotate-0",
                )}
                aria-hidden
              />
            </button>
            <div
              data-testid="accordion-content"
              className={cn(
                "grid overflow-hidden border-t text-sm transition-[grid-template-rows] duration-[var(--duration-slow)] ease-[var(--ease-out)]",
                open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="p-3">{item.content}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
