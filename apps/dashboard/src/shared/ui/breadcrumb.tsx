/**
 * apps/dashboard/src/shared/ui/breadcrumb.tsx — breadcrumb trail.
 */
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export interface BreadcrumbItem {
  readonly label: string;
  readonly href?: string;
}

export const Breadcrumb = ({ items }: { items: ReadonlyArray<BreadcrumbItem> }): ReactNode => (
  <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
    {items.map((item, idx) => {
      const last = idx === items.length - 1;
      return (
        <span key={`${item.label}-${idx}`} className="flex items-center gap-1.5">
          {item.href && !last ? (
            <a href={item.href} className="text-muted-foreground hover:text-foreground">
              {item.label}
            </a>
          ) : (
            <span className={last ? "font-medium" : "text-muted-foreground"}>{item.label}</span>
          )}
          {!last ? <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden /> : null}
        </span>
      );
    })}
  </nav>
);
