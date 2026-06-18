import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Sidebar } from "./index";
import { SidebarProvider } from "./sidebar-provider";

const renderSidebar = (initialPath = "/") =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SidebarProvider>
        <Sidebar />
      </SidebarProvider>
    </MemoryRouter>,
  );

describe("Sidebar", () => {
  it("renders 7 nav links grouped into Main, Explore, Admin sections", () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: /primary/i });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(7);

    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "Timeline" })).toHaveAttribute("href", "/timeline");
    expect(within(nav).getByRole("link", { name: "Knowledge Graph" })).toHaveAttribute("href", "/knowledge-graph");
    expect(within(nav).getByRole("link", { name: "Decision Graph" })).toHaveAttribute("href", "/decision-graph");
    expect(within(nav).getByRole("link", { name: "Verification" })).toHaveAttribute("href", "/verification");
    expect(within(nav).getByRole("link", { name: "Recovery" })).toHaveAttribute("href", "/recovery-center");
    expect(within(nav).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");

    expect(within(nav).getByText("Main")).toBeInTheDocument();
    expect(within(nav).getByText("Explore")).toBeInTheDocument();
    expect(within(nav).getByText("Admin")).toBeInTheDocument();
  });

  it("toggles collapsed state via the toggle button", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: /primary/i });
    // initially expanded: "Overview" link is visible
    const overviewLink = within(nav).getByRole("link", { name: "Overview" });
    expect(overviewLink).toBeVisible();

    const toggle = screen.getByRole("button", { name: /collapse sidebar/i });
    await user.click(toggle);

    // after collapse, Overview text node is no longer rendered (label hidden)
    expect(within(nav).queryByText("Overview")).toBeNull();
    expect(within(nav).getByRole("link", { name: "Overview" })).toBeInTheDocument();
  });
});
