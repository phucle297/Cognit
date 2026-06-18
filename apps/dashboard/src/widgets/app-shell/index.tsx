/**
 * apps/dashboard/src/widgets/app-shell/index.tsx — app layout.
 *
 * Two-column on lg+ (sidebar + main). Wraps the route Outlet
 * with the page-enter animation and the SidebarProvider so
 * child routes can read sidebar state.
 */
import { Outlet } from "react-router-dom";
import type { JSX } from "react";
import { NavBar } from "@/widgets/nav-bar";
import { Sidebar } from "@/widgets/sidebar";
import { SidebarProvider, useSidebar } from "@/widgets/sidebar/sidebar-provider";
import { pageEnter } from "@/shared/lib/motion";

const Main = (): JSX.Element => {
  const { collapsed } = useSidebar();
  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="flex-1 px-[var(--space-page-x)] py-[var(--space-page-y)]">
        <div className="mx-auto w-full max-w-6xl">
          <div key={collapsed ? "c" : "e"} className={pageEnter()}>
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
