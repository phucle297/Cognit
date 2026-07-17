/**
 * apps/dashboard/src/widgets/sidebar/index.tsx — left rail nav.
 *
 * Phase A.6: public surface is four tabs — Overview / Timeline /
 * Graph / Settings. Internal pages (decision-graph, verification,
 * ai-reasoning, recovery-center, rules) keep their routes so deep
 * links still work, but they no longer appear in the sidebar. They
 * remain reachable only by URL — for AI callers, the developer-ex
 * team, and anyone who has bookmarked them from before the cut.
 *
 * Light theme — uses the existing design tokens in
 * `apps/dashboard/src/app/index.css`.
 */
import {
  Boxes,
  Cog,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  PlusCircle,
  ScrollText,
  Share2,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { useSidebar } from "./sidebar-provider";
import { cn } from "@/shared/lib/cn";
import { transition } from "@/shared/lib/motion";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Optional badge counter (e.g. unread notifications). */
  badge?: string;
}

const SECTIONS: ReadonlyArray<{
  title: string;
  items: ReadonlyArray<NavItem>;
}> = [
  {
    title: "Cognit",
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboard },
      { to: "/timeline", label: "Timeline", icon: ScrollText },
      { to: "/knowledge-graph", label: "Graph", icon: Share2 },
      { to: "/settings", label: "Settings", icon: Cog },
    ],
  },
];

const QUICK_ACTIONS: ReadonlyArray<{ label: string; icon: LucideIcon; to: string }> = [
  { label: "New Session", icon: PlusCircle, to: "/?new=session" },
];

export const Sidebar = () => {
  const { collapsed, toggle } = useSidebar();
  return (
    <aside
      data-testid="sidebar"
      className={cn(
        "sticky top-0 flex h-screen flex-col border-r border-[var(--color-border-subtle)] bg-card",
        transition("width", "base"),
        collapsed ? "w-14" : "w-56",
      )}
    >
      {/* Brand area — square logo chip + wordmark. Collapses to chip-only. */}
      <div
        className={cn(
          "flex h-14 items-center gap-2.5 border-b border-[var(--color-border-subtle)]",
          collapsed ? "justify-center px-2" : "px-4",
        )}
      >
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-[var(--color-brand)] text-[var(--color-brand-foreground)] shadow-sm"
          aria-hidden
        >
          <Boxes className="size-4" />
        </div>
        {!collapsed ? (
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold tracking-tight">Cognit</span>
            <span className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
              Knowledge layer
            </span>
          </div>
        ) : null}
      </div>

      <nav className="flex-1 overflow-y-auto p-2" aria-label="Primary">
        {SECTIONS.map((section) => (
          <div key={section.title} className="mb-4">
            {!collapsed ? (
              <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {section.title}
              </div>
            ) : null}
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                data-testid={`sidebar-link-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                className={({ isActive }) =>
                  cn(
                    "group relative flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm font-medium tracking-wide",
                    transition("colors", "fast"),
                    isActive
                      ? "bg-[var(--color-brand-bg)] text-[var(--color-brand)]"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
                    collapsed && "justify-center",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {/* Left rail accent — visible only on active item, expanded sidebar only. */}
                    {!collapsed && isActive ? (
                      <span
                        aria-hidden
                        className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-[var(--color-brand)]"
                      />
                    ) : null}
                    <item.icon
                      className={cn(
                        "size-4 shrink-0",
                        isActive
                          ? "text-[var(--color-brand)]"
                          : "text-muted-foreground group-hover:text-foreground",
                      )}
                      aria-hidden
                    />
                    {!collapsed ? (
                      <>
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.badge !== undefined ? (
                          <span
                            className="ml-auto rounded-full bg-[var(--color-brand)] px-1.5 text-[10px] font-semibold leading-5 text-[var(--color-brand-foreground)]"
                            aria-label={`${item.badge} pending`}
                          >
                            {item.badge}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}

        {/* Quick Actions — secondary nav block, mirrors Alina template footer. */}
        {!collapsed ? (
          <div className="mb-2 mt-6">
            <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Quick Actions
            </div>
            {QUICK_ACTIONS.map((action) => (
              <NavLink
                key={action.label}
                to={action.to}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium",
                  "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
                  transition("colors", "fast"),
                )}
              >
                <action.icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{action.label}</span>
              </NavLink>
            ))}
          </div>
        ) : null}
      </nav>

      <button
        type="button"
        onClick={toggle}
        className={cn(
          "flex h-10 items-center border-t border-[var(--color-border-subtle)] text-sm text-muted-foreground hover:bg-accent/60",
          transition("colors", "fast"),
          collapsed ? "justify-center" : "px-4",
        )}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? (
          <PanelLeftOpen className="size-4" />
        ) : (
          <>
            <PanelLeftClose className="size-4" aria-hidden />
            <span className="ml-2">Collapse</span>
          </>
        )}
      </button>
    </aside>
  );
};
