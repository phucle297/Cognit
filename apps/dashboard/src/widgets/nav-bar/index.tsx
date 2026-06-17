/**
 * apps/dashboard/src/widgets/nav-bar/index.tsx — top navigation.
 *
 * FSD layer: widgets. Stateless, presentational; uses NavLink
 * to highlight the active route.
 */
import { NavLink } from "react-router-dom";
import type { JSX } from "react";
import { cn } from "@/shared/lib/cn";

const LINKS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "/", label: "Overview" },
  { to: "/timeline", label: "Timeline" },
  { to: "/knowledge-graph", label: "Knowledge Graph" },
  { to: "/decision-graph", label: "Decision Graph" },
  { to: "/verification", label: "Verification" },
  { to: "/recovery-center", label: "Recovery" },
  { to: "/settings", label: "Settings" },
];

export const NavBar = (): JSX.Element => {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-6">
        <div className="text-base font-semibold tracking-tight">Cognit</div>
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === "/"}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
};
