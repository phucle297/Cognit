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
  it("renders the 8 primary nav links + 3 Quick Actions + section headers", () => {
    renderSidebar();
    const aside = screen.getByRole("complementary");
    // 8 primary nav links (Main / Explore / Admin) + 3 Quick Actions = 11 total links.
    const links = within(aside).getAllByRole("link");
    expect(links).toHaveLength(11);

    // Primary nav links (Main / Explore / Admin).
    expect(within(aside).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/");
    expect(within(aside).getByRole("link", { name: "Timeline" })).toHaveAttribute("href", "/timeline");
    expect(within(aside).getByRole("link", { name: "Knowledge Graph" })).toHaveAttribute("href", "/knowledge-graph");
    expect(within(aside).getByRole("link", { name: "Decision Graph" })).toHaveAttribute("href", "/decision-graph");
    expect(within(aside).getByRole("link", { name: "Verification" })).toHaveAttribute("href", "/verification");
    expect(within(aside).getByRole("link", { name: "AI Reasoning" })).toHaveAttribute("href", "/ai-reasoning");
    expect(within(aside).getByRole("link", { name: "Recovery" })).toHaveAttribute("href", "/recovery-center");
    expect(within(aside).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");

    // Section headers.
    expect(within(aside).getByText("Main")).toBeInTheDocument();
    expect(within(aside).getByText("Explore")).toBeInTheDocument();
    expect(within(aside).getByText("Admin")).toBeInTheDocument();

    // Quick Actions block + entries.
    expect(within(aside).getByText("Quick Actions")).toBeInTheDocument();
    expect(within(aside).getByRole("link", { name: /New Session/i })).toBeInTheDocument();
    expect(within(aside).getByRole("link", { name: /Rules/i })).toBeInTheDocument();
    expect(within(aside).getByRole("link", { name: /Snapshots/i })).toBeInTheDocument();
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
      within(aside).getAllByRole("link").find((a) => a.getAttribute("href") === "/"),
    ).toBeDefined();

    // toggle back: Expand sidebar button now present
    const expand = screen.getByRole("button", { name: /expand sidebar/i });
    await user.click(expand);
    expect(within(aside).getByText("Overview")).toBeInTheDocument();
  });
});
