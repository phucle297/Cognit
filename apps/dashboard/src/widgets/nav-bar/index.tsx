/**
 * apps/dashboard/src/widgets/nav-bar/index.tsx — top chrome.
 *
 * Restyled to match the Alina template topbar pattern: breadcrumb
 * on the left, search input in the middle (placeholder — wires to
 * the recovery-center search API in a follow-up), notification
 * bell with badge counter on the right, user profile chip, and
 * a version label for the build.
 */
import type { JSX } from "react";
import { Bell, Search } from "lucide-react";
import { Breadcrumb } from "@/shared/ui/breadcrumb";
import { Input } from "@/shared/ui/input";
import { transition } from "@/shared/lib/motion";

const VERSION = "0.1.0";
const NOTIFICATION_COUNT = 3;

export const NavBar = (): JSX.Element => {
  return (
    <header
      data-testid="nav-bar"
      className="flex h-14 items-center gap-4 border-b bg-card px-[var(--space-page-x)]"
    >
      <Breadcrumb items={[{ label: "Cognit" }]} />

      {/* Search — wires to /api/sessions/search in a follow-up. */}
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

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden text-xs text-muted-foreground md:inline" aria-label="App version">
          v{VERSION}
        </span>

        {/* Notification bell w/ badge counter. */}
        <button
          type="button"
          aria-label={`Notifications (${NOTIFICATION_COUNT} unread)`}
          data-testid="nav-bar-notifications"
          className={
            "relative flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground " +
            transition("colors", "fast")
          }
        >
          <Bell className="size-4" aria-hidden />
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 inline-flex size-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-brand)] px-1 text-[10px] font-semibold leading-none text-[var(--color-brand-foreground)]"
          >
            {NOTIFICATION_COUNT}
          </span>
        </button>

        {/* User profile chip — initial avatar + name slot. */}
        <button
          type="button"
          aria-label="User profile"
          data-testid="nav-bar-profile"
          className={
            "flex h-9 items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent/60 " +
            transition("colors", "fast")
          }
        >
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-full bg-[var(--color-brand)] text-xs font-semibold text-[var(--color-brand-foreground)]"
          >
            C
          </span>
          <span className="hidden text-sm font-medium md:inline">cognit</span>
        </button>
      </div>
    </header>
  );
};
