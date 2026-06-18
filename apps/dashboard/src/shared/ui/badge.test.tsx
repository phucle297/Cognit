import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";

describe("Badge", () => {
  it("renders default neutral badge", () => {
    render(<Badge>Tag</Badge>);
    expect(screen.getByText("Tag")).toBeInTheDocument();
  });

  it.each(["active", "pending", "failed", "verified", "archived"] as const)(
    "renders %s variant",
    (variant) => {
      render(<Badge variant={variant}>{variant}</Badge>);
      expect(screen.getByText(variant)).toBeInTheDocument();
    },
  );
});
