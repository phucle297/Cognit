/**
 * apps/dashboard/src/widgets/app-shell/index.tsx — app layout.
 *
 * Two-column on lg+ (sidebar + main). Graph route uses full width
 * so the canvas is not crushed by max-w-6xl.
 */
import { Outlet, useLocation } from "react-router-dom";
import type { JSX } from "react";
import { NavBar } from "@/widgets/nav-bar";
import { Sidebar } from "@/widgets/sidebar";
import { SidebarProvider } from "@/widgets/sidebar/sidebar-provider";
import { pageEnter } from "@/shared/lib/motion";
import { cn } from "@/shared/lib/cn";

const Main = (): JSX.Element => {
  const { pathname } = useLocation();
  const fullBleed = pathname === "/knowledge-graph";
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <NavBar />
      <main
        className={cn(
          "flex-1",
          fullBleed
            ? "px-0 py-0"
            : "px-[var(--space-page-x)] py-[var(--space-page-y)]",
        )}
      >
        <div className={cn("mx-auto w-full", fullBleed ? "max-w-none" : "max-w-6xl")}>
          <div key={pathname} className={pageEnter()}>
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
};

export const AppShell = (): JSX.Element => (
  <SidebarProvider>
    <div className="grid min-h-screen bg-background lg:grid-cols-[auto_1fr]">
      <Sidebar />
      <Main />
    </div>
  </SidebarProvider>
);
