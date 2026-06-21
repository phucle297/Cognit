/**
 * apps/dashboard/src/widgets/nav-bar/index.tsx — top chrome.
 *
 * Slim topbar in the Alina template pattern: breadcrumb on the
 * left, a global search input (placeholder — wires to the
 * recovery-center search API in a follow-up), and a version label
 * on the right. No notification bell or user profile chip —
 * Cognit is local-first CLI tooling and has no notification feed
 * or auth surface yet.
 */
import type { JSX } from "react";
import { Search } from "lucide-react";
import { Breadcrumb } from "@/shared/ui/breadcrumb";
import { Input } from "@/shared/ui/input";

const VERSION = "0.1.0";

export const NavBar = (): JSX.Element => {
  return (
    <header
      data-testid="nav-bar"
      className="flex h-14 items-center gap-4 border-b border-[oklch(0.88_0_0)] bg-card px-[var(--space-page-x)]"
    >
      <Breadcrumb items={[{ label: "Cognit" }]} />

      <div className="relative ml-2 hidden max-w-md flex-1 sm:block">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          placeholder="Search sessions, observations, decisions…"
          aria-label="Global search"
          className="h-9 pl-8 pr-3 text-sm"
        />
      </div>

      <span className="ml-auto text-xs text-muted-foreground" aria-label="App version">
        v{VERSION}
      </span>
    </header>
  );
};
