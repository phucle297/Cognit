/**
 * apps/dashboard/src/widgets/app-shell/index.tsx — app layout.
 *
 * FSD layer: widgets. Composes NavBar + the route Outlet. Pages
 * render inside <Outlet />; the shell itself owns the chrome.
 */
import { Outlet } from "react-router-dom";
import type { JSX } from "react";
import { NavBar } from "@/widgets/nav-bar";

export const AppShell = (): JSX.Element => {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <NavBar />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto w-full max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
};
