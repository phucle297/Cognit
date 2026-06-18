import { render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";
import { Button } from "./button";

describe("EmptyState", () => {
  it("renders title and description", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="No sessions"
        description="Start one to see it here."
      />,
    );
    expect(screen.getByText("No sessions")).toBeInTheDocument();
    expect(screen.getByText("Start one to see it here.")).toBeInTheDocument();
  });

  it("renders action when provided", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="No sessions"
        action={<Button>New</Button>}
      />,
    );
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });
});
