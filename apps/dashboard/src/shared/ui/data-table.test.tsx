import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "./data-table";

interface Row { id: string; name: string; count: number }
const cols: ReadonlyArray<DataTableColumn<Row>> = [
  { key: "name", header: "Name" },
  { key: "count", header: "Count" },
];
const rows: Row[] = [{ id: "1", name: "alpha", count: 3 }];

describe("DataTable", () => {
  it("renders headers and cells", () => {
    render(<DataTable columns={cols} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("calls onRowClick when row clicked", () => {
    const onRowClick = vi.fn();
    render(
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={onRowClick} />,
    );
    fireEvent.click(screen.getByText("alpha"));
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });
});
