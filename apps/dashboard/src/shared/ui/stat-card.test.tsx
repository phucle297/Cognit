import { render, screen } from "@testing-library/react";
import { Activity } from "lucide-react";
import { describe, expect, it } from "vitest";
import { StatCard } from "./stat-card";

describe("StatCard", () => {
  it("renders label and value", () => {
    render(<StatCard label="Sessions" value={12} />);
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("renders delta with sign", () => {
    render(<StatCard label="Events" value={42} delta={3} />);
    expect(screen.getByText("+3")).toBeInTheDocument();
  });

  it("renders negative delta", () => {
    render(<StatCard label="Events" value={42} delta={-2} />);
    expect(screen.getByText("-2")).toBeInTheDocument();
  });

  it("renders icon when provided", () => {
    render(<StatCard label="X" value={1} icon={Activity} />);
    // Lucide icons render as <svg> with class containing "lucide-activity".
    expect(document.querySelector("svg.lucide-activity")).toBeInTheDocument();
  });
});
