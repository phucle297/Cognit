/**
 * apps/dashboard/src/widgets/sidebar/index.tsx — primary nav.
 *
 * FSD layer: widgets. Composes 7 NavLink entries grouped into
 * Main / Explore / Admin sections. Reads collapsed state from
 * SidebarProvider; width switches between w-14 and w-56 so the
 * parent grid (lg:grid-cols-[auto_1fr]) reflows without media
 * queries. Icons come from lucide-react.
 */
import {
  Activity,
  GitBranch,
  Layers,
  LifeBuoy,
  Settings as SettingsIcon,
  ShieldCheck,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import type { JSX } from "react";
import { cn } from "@/shared/lib/cn";
import { useSidebar } from "./sidebar-provider";

interface NavEntry {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly end?: boolean;
}

interface NavSection {
  readonly title: string;
  readonly items: ReadonlyArray<NavEntry>;
}

const SECTIONS: ReadonlyArray<NavSection> = [
  {
    title: "Main",
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/timeline", label: "Timeline", icon: Activity },
    ],
  },
  {
    title: "Explore",
    items: [
      { to: "/knowledge-graph", label: "Knowledge Graph", icon: Layers },
      { to: "/decision-graph", label: "Decision Graph", icon: GitBranch },
      { to: "/verification", label: "Verification", icon: ShieldCheck },
    ],
  },
  {
    title: "Admin",
    items: [
      { to: "/recovery-center", label: "Recovery", icon: LifeBuoy },
      { to: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

export const Sidebar = (): JSX.Element => {
  const { collapsed, toggle } = useSidebar();

  return (
    <aside
      className={cn(
        "border-r bg-card",
        collapsed ? "w-14" : "w-56",
        "shrink-0",
      )}
      aria-label="Primary sidebar"
    >
      <nav
        aria-label="Primary"
        className={cn(
          "flex h-full flex-col gap-4 py-4",
          collapsed ? "px-2" : "px-3",
        )}
      >
        <div className={cn("flex items-center", collapsed ? "justify-center" : "justify-end")}>
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden />
            ) : (
              <PanelLeftClose className="size-4" aria-hidden />
            )}
          </button>
        </div>

        <ul className="flex flex-1 flex-col gap-4">
          {SECTIONS.map((section) => (
            <li key={section.title} className="flex flex-col gap-1">
              {!collapsed ? (
                <div className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {section.title}
                </div>
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.end ?? false}
                        aria-label={item.label}
                        className={({ isActive }) =>
                          cn(
                            "group flex items-center gap-3 rounded-md text-sm font-medium",
                            collapsed ? "h-9 w-9 justify-center" : "h-9 px-2",
                            isActive
                              ? "bg-accent text-accent-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                          )
                        }
                      >
                        <Icon className="size-4 shrink-0" aria-hidden />
                        {!collapsed ? <span className="truncate">{item.label}</span> : null}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
};
