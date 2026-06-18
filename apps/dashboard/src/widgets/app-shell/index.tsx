/**
 * apps/dashboard/src/widgets/app-shell/index.tsx — app layout.
 *
 * FSD layer: widgets. Composes the Sidebar (with its
 * SidebarProvider) and a Main column that holds the NavBar
 * above the route Outlet. The grid is `auto 1fr` so the
 * sidebar drives its own width (w-14 collapsed / w-56
 * expanded) and the main column reflows naturally. The
 * Outlet's wrapper uses `pageEnter()` for the route-change
 * animation; the `key` is the current pathname so each
 * navigation re-mounts and re-plays the keyframes.
 */
import { Outlet, useLocation } from "react-router-dom";
import type { JSX } from "react";
import { NavBar } from "@/widgets/nav-bar";
import { Sidebar } from "@/widgets/sidebar";
import { SidebarProvider } from "@/widgets/sidebar/sidebar-provider";
import { pageEnter } from "@/shared/lib/motion";

export const AppShell = (): JSX.Element => {
  const location = useLocation();
  const enterClass = pageEnter();

  return (
    <SidebarProvider>
      <div className="grid min-h-screen grid-cols-1 bg-background text-foreground lg:grid-cols-[auto_1fr]">
        <Sidebar />
        <div className="flex min-h-screen min-w-0 flex-col">
          <NavBar />
          <main
            key={location.pathname}
            className={`flex-1 px-[var(--space-page-x)] py-[var(--space-page-y)] ${enterClass}`}
          >
            <div className="mx-auto w-full max-w-6xl">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
};
