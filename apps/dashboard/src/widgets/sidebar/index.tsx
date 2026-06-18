/**
 * apps/dashboard/src/widgets/sidebar/index.tsx — left rail nav.
 */
import { Boxes, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NavLink } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { useSidebar } from "./sidebar-provider";
import { cn } from "@/shared/lib/cn";
import { transition } from "@/shared/lib/motion";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const SECTIONS: ReadonlyArray<{ title: string; items: ReadonlyArray<NavItem> }> = [
  {
    title: "Main",
    items: [
      { to: "/", label: "Overview", icon: Boxes },
      { to: "/timeline", label: "Timeline", icon: Boxes },
    ],
  },
  {
    title: "Explore",
    items: [
      { to: "/knowledge-graph", label: "Knowledge Graph", icon: Boxes },
      { to: "/decision-graph", label: "Decision Graph", icon: Boxes },
      { to: "/verification", label: "Verification", icon: Boxes },
    ],
  },
  {
    title: "Admin",
    items: [
      { to: "/recovery-center", label: "Recovery", icon: Boxes },
      { to: "/settings", label: "Settings", icon: Boxes },
    ],
  },
];

export const Sidebar = () => {
  const { collapsed, toggle } = useSidebar();
  return (
    <aside
      className={cn(
        "sticky top-0 flex h-screen flex-col border-r bg-card",
        transition("width", "base"),
        collapsed ? "w-14" : "w-56",
      )}
    >
      <div className={cn("flex h-12 items-center border-b", collapsed ? "justify-center px-2" : "px-4")}>
        <Boxes className="size-5 shrink-0" aria-hidden />
        {!collapsed ? <span className="ml-2 font-semibold tracking-tight">Cognit</span> : null}
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {SECTIONS.map((section) => (
          <div key={section.title} className="mb-4">
            {!collapsed ? (
              <div className="mb-1 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {section.title}
              </div>
            ) : null}
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium",
                    transition("colors", "fast"),
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
                    collapsed && "justify-center",
                  )
                }
              >
                <item.icon className="size-4 shrink-0" aria-hidden />
                {!collapsed ? <span>{item.label}</span> : null}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <button
        type="button"
        onClick={toggle}
        className={cn(
          "flex h-10 items-center border-t text-sm text-muted-foreground hover:bg-accent/60",
          transition("colors", "fast"),
          collapsed ? "justify-center" : "px-4",
        )}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        {!collapsed ? <span className="ml-2">Collapse</span> : null}
      </button>
    </aside>
  );
};
