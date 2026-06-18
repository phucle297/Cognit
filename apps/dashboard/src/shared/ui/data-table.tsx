/**
 * apps/dashboard/src/shared/ui/data-table.tsx — simple sortable table.
 */
import { useState, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface DataTableColumn<T> {
  readonly key: string;
  readonly header: string;
  readonly render?: (row: T) => ReactNode;
  readonly width?: string;
}

export interface DataTableProps<T> {
  readonly columns: ReadonlyArray<DataTableColumn<T>>;
  readonly rows: ReadonlyArray<T>;
  readonly rowKey: (row: T) => string;
  readonly onRowClick?: (row: T) => void;
  readonly className?: string;
  readonly emptyMessage?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  className,
  emptyMessage = "No items.",
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
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/50 text-left">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className="cursor-pointer select-none px-4 py-2.5 font-medium text-muted-foreground hover:text-foreground"
                onClick={() => toggleSort(c.key)}
              >
                {c.header}
                {sortBy?.key === c.key ? (sortBy.dir === "asc" ? " ↑" : " ↓") : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                "border-b last:border-b-0",
                onRowClick && "cursor-pointer transition-colors hover:bg-muted/50",
              )}
            >
              {columns.map((c) => (
                <td key={c.key} className="px-4 py-2.5">
                  {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
