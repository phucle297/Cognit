import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Breadcrumb } from "./breadcrumb";

describe("Breadcrumb", () => {
  it("renders items as links", () => {
    render(<Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Sessions" }]} />);
    expect(screen.getByText("Home").closest("a")).toHaveAttribute("href", "/");
    expect(screen.getByText("Sessions")).toBeInTheDocument();
  });
});
