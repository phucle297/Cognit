/**
 * apps/dashboard/src/widgets/nav-bar/index.tsx — top chrome.
 *
 * Search is intentionally non-functional (placeholder styling) until
 * it is wired to recovery search. Cognit is local-first; no auth chip.
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
      className="flex h-14 items-center gap-4 border-b border-border bg-card px-[var(--space-page-x)]"
    >
      <Breadcrumb items={[{ label: "Cognit" }]} />

      <div className="relative ml-2 hidden max-w-md flex-1 sm:block">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          placeholder="Search coming soon…"
          aria-label="Global search (not available yet)"
          disabled
          readOnly
          className="h-9 cursor-not-allowed pl-8 pr-3 text-sm opacity-70"
          data-testid="nav-search-placeholder"
        />
      </div>

      <span className="ml-auto text-xs text-muted-foreground" aria-label="App version">
        v{VERSION}
      </span>
    </header>
  );
};
