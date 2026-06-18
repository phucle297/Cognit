/**
 * apps/dashboard/src/widgets/nav-bar/index.tsx — top chrome.
 *
 * FSD layer: widgets. With the sidebar owning the primary nav,
 * the top bar is now a thin breadcrumb strip plus a version
 * label on the right. Static breadcrumb for v0.1 — pages
 * upgrade it via context in a later phase.
 */
import type { JSX } from "react";
import { Breadcrumb } from "@/shared/ui/breadcrumb";

const VERSION = "0.1.0";

export const NavBar = (): JSX.Element => {
  return (
    <header className="flex h-12 items-center justify-between border-b bg-card px-[var(--space-page-x)]">
      <Breadcrumb items={[{ label: "Cognit" }]} />
      <span className="text-xs text-muted-foreground" aria-label="App version">
        v{VERSION}
      </span>
    </header>
  );
};
