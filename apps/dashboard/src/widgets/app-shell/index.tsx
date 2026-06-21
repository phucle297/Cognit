/**
 * apps/dashboard/src/widgets/app-shell/index.tsx — app layout.
 *
 * Two-column on lg+ (sidebar + main). Wraps the route Outlet
 * with the page-enter animation and the SidebarProvider so
 * child routes can read sidebar state. The animation key follows
 * `location.pathname` so navigating between routes replays the
 * fade-in; the sidebar collapse transition is its own animation
 * (driven by the `transition("width", "base")` helper on the
 * sidebar aside) so we do NOT re-key on collapse.
 */
import { Outlet, useLocation } from "react-router-dom";
import type { JSX } from "react";
import { NavBar } from "@/widgets/nav-bar";
import { Sidebar } from "@/widgets/sidebar";
import { SidebarProvider } from "@/widgets/sidebar/sidebar-provider";
import { pageEnter } from "@/shared/lib/motion";

const Main = (): JSX.Element => {
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="flex-1 px-[var(--space-page-x)] py-[var(--space-page-y)]">
        <div className="mx-auto w-full max-w-6xl">
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
    <div className="grid lg:grid-cols-[auto_1fr]">
      <Sidebar />
      <Main />
    </div>
  </SidebarProvider>
);
