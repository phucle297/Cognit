/**
 * apps/dashboard/src/shared/ui/data-table.tsx — simple sortable table.
 *
 * Restyled to match the Alina table pattern: sticky header, hover
 * row highlight, optional zebra striping, tabular numerics for
 * any numeric cells (consumer can opt in via `numeric: true` on
 * the column). Sortable columns show direction glyph on the
 * active header.
 */
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../lib/cn";

export interface DataTableColumn<T> {
  readonly key: string;
  readonly header: string;
  readonly render?: (row: T) => ReactNode;
  readonly width?: string;
  /** Right-align + tabular nums. Use for numeric columns. */
  readonly numeric?: boolean;
  /** Disable sort for this column (e.g. action column). */
  readonly disableSort?: boolean;
}

export interface DataTableProps<T> {
  readonly columns: ReadonlyArray<DataTableColumn<T>>;
  readonly rows: ReadonlyArray<T>;
  readonly rowKey: (row: T) => string;
  readonly onRowClick?: (row: T) => void;
  readonly className?: string;
  readonly emptyMessage?: string;
  /** Zebra striping — off by default to keep dense tables readable. */
  readonly striped?: boolean;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  className,
  emptyMessage = "No items.",
  striped = false,
}: DataTableProps<T>) {
  const [sortBy, setSortBy] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);

  const sorted = sortBy
    ? [...rows].sort((a, b) => {
        const av = String((a as Record<string, unknown>)[sortBy.key] ?? "");
        const bv = String((b as Record<string, unknown>)[sortBy.key] ?? "");
        return sortBy.dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      })
    : rows;

  const toggleSort = (key: string) =>
    setSortBy((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card shadow-[var(--shadow-sm)]", className)}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 border-b bg-muted/60 text-left text-xs uppercase tracking-wider text-muted-foreground backdrop-blur">
            <tr>
              {columns.map((c) => {
                const isActive = sortBy?.key === c.key;
                return (
                  <th
                    key={c.key}
                    style={c.width ? { width: c.width } : undefined}
                    className={cn(
                      "select-none px-4 py-2.5 font-medium",
                      c.numeric && "text-right",
                      !c.disableSort && "cursor-pointer hover:text-foreground",
                    )}
                    onClick={c.disableSort ? undefined : () => toggleSort(c.key)}
                    aria-sort={isActive ? (sortBy!.dir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <span className="inline-flex items-center gap-1">
                      <span>{c.header}</span>
                      {isActive ? (
                        sortBy!.dir === "asc" ? (
                          <ChevronUp className="size-3" aria-hidden />
                        ) : (
                          <ChevronDown className="size-3" aria-hidden />
                        )
                      ) : null}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, rowIdx) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  "border-b last:border-b-0",
                  onRowClick && "cursor-pointer transition-colors hover:bg-muted/40",
                  striped && rowIdx % 2 === 1 && "bg-muted/20",
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "px-4 py-3 align-middle",
                      c.numeric && "text-right tabular-nums",
                    )}
                  >
                    {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
