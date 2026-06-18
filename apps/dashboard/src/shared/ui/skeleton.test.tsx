import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  it("renders with default rect variant", () => {
    render(<Skeleton data-testid="sk" className="h-4 w-32" />);
    const el = screen.getByTestId("sk");
    expect(el.className).toMatch(/animate-pulse/);
  });

  it("renders text variant", () => {
    render(<Skeleton variant="text" data-testid="sk" />);
    const el = screen.getByTestId("sk");
    expect(el.className).toMatch(/h-4/);
  });
});
