/**
 * apps/dashboard/src/shared/ui/sheet.tsx — slide-in side panel.
 *
 * FSD layer: shared. Headless side sheet (no Radix dep) for
 * timeline row details, knowledge-graph node details, and any
 * other "show full info on click" use case. Anchored to the
 * right edge; Esc + backdrop click dismiss.
 *
 * Token-driven: width + motion use the @theme variables
 * (--radius-lg, --ease-out, --duration-base).
 */
import { useEffect, type JSX, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";

export interface SheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly width?: "sm" | "md" | "lg";
  readonly side?: "right" | "left";
  readonly className?: string;
  readonly "data-testid"?: string;
}

const WIDTH_MAP: Record<NonNullable<SheetProps["width"]>, string> = {
  sm: "w-80",
  md: "w-96",
  lg: "w-[28rem]",
};

export const Sheet = ({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "md",
  side = "right",
  className,
  "data-testid": testId,
}: SheetProps): JSX.Element | null => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      data-testid={testId}
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
    >
      <button
        type="button"
        aria-label="Close panel"
        data-testid="sheet-backdrop"
        onClick={onClose}
        className="flex-1 bg-black/40 backdrop-blur-sm"
      />
      <div
        data-testid="sheet-panel"
        className={cn(
          "flex h-full flex-col border bg-card shadow-[var(--shadow-md)]",
          "animate-[page-enter_var(--duration-base)_var(--ease-out)_both]",
          WIDTH_MAP[width],
          side === "right" ? "border-l" : "border-r",
          side === "right" ? "right-0" : "left-0",
          className,
        )}
      >
        <header className="flex items-start justify-between gap-2 border-b p-4">
          <div className="min-w-0 flex-1">
            {title ? (
              <h2 className="truncate text-base font-semibold tracking-tight">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="sheet-close"
            aria-label="Close"
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 text-sm">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t p-4">{footer}</footer>
        ) : null}
      </div>
    </div>
  );
};
