import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Sidebar } from "./index";
import { SidebarProvider } from "./sidebar-provider";

const renderSidebar = (initialPath = "/") =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SidebarProvider defaultCollapsed={false}>
        <Sidebar />
      </SidebarProvider>
    </MemoryRouter>,
  );

describe("Sidebar", () => {
  it("renders the 4 public nav links + 1 Quick Action + section header", () => {
    renderSidebar();
    const aside = screen.getByRole("complementary");
    // Phase A.6: 4 public nav links (Overview / Timeline / Graph /
    // Settings) + 1 Quick Action (New Session) = 5 total links.
    const links = within(aside).getAllByRole("link");
    expect(links).toHaveLength(5);

    // Public nav links.
    expect(within(aside).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/");
    expect(within(aside).getByRole("link", { name: "Timeline" })).toHaveAttribute(
      "href",
      "/timeline",
    );
    expect(within(aside).getByRole("link", { name: "Graph" })).toHaveAttribute(
      "href",
      "/knowledge-graph",
    );
    expect(within(aside).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );

    // Section header (the nav block label "Cognit" — distinct from
    // the brand wordmark which shares the text but lives in the
    // header strip).
    expect(within(aside).getAllByText("Cognit").length).toBeGreaterThanOrEqual(1);

    // Quick Actions block.
    expect(within(aside).getByText("Quick Actions")).toBeInTheDocument();
    expect(within(aside).getByRole("link", { name: /New Session/i })).toBeInTheDocument();

    // Internal pages must NOT be in the sidebar.
    expect(within(aside).queryByRole("link", { name: "Decision Graph" })).toBeNull();
    expect(within(aside).queryByRole("link", { name: "Verification" })).toBeNull();
    expect(within(aside).queryByRole("link", { name: "AI Reasoning" })).toBeNull();
    expect(within(aside).queryByRole("link", { name: "Recovery" })).toBeNull();
    expect(within(aside).queryByRole("link", { name: /Rules/i })).toBeNull();
    expect(within(aside).queryByRole("link", { name: /Snapshots/i })).toBeNull();
  });

  it("toggles collapsed state via the toggle button", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const aside = screen.getByRole("complementary");
    // initially expanded: "Overview" link is visible
    const overviewLink = within(aside).getByRole("link", { name: "Overview" });
    expect(overviewLink).toBeVisible();

    const toggle = screen.getByRole("button", { name: /collapse sidebar/i });
    await user.click(toggle);

    // after collapse, Overview text node is no longer rendered (label hidden)
    expect(within(aside).queryByText("Overview")).toBeNull();
    // link is still in the DOM (queried by href because the visible label
    // is unmounted when collapsed)
    expect(
      within(aside)
        .getAllByRole("link")
        .find((a) => a.getAttribute("href") === "/"),
    ).toBeDefined();

    // toggle back: Expand sidebar button now present
    const expand = screen.getByRole("button", { name: /expand sidebar/i });
    await user.click(expand);
    expect(within(aside).getByText("Overview")).toBeInTheDocument();
  });
});
