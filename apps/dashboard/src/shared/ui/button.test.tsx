import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("renders default button", () => {
    render(<Button>Click</Button>);
    expect(screen.getByRole("button", { name: "Click" })).toBeInTheDocument();
  });

  it("renders subtle variant", () => {
    render(<Button variant="subtle">Subtle</Button>);
    const btn = screen.getByRole("button", { name: "Subtle" });
    expect(btn.className).toMatch(/bg-muted/);
  });

  it("renders link variant", () => {
    render(<Button variant="link">Link</Button>);
    const btn = screen.getByRole("button", { name: "Link" });
    expect(btn.className).toMatch(/underline-offset/);
  });
});
