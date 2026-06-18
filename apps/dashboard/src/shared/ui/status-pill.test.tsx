import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusPill } from "./status-pill";

describe("StatusPill", () => {
  it("renders label and applies active color", () => {
    render(<StatusPill status="active" data-testid="pill" />);
    const el = screen.getByTestId("pill");
    expect(el.className).toMatch(/status-active/);
  });

  it("respects custom label", () => {
    render(<StatusPill status="pending" label="In progress" />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });
});
