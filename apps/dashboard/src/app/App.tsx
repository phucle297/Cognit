/**
 * apps/dashboard/src/app/App.tsx — root component.
 *
 * Currently a thin wrapper around the router. Kept for future
 * providers (theme, toaster, etc.). Re-exported via
 * src/components/AppShell.tsx to keep FSD canonical here.
 */
import type { JSX } from "react";

export const App = (): JSX.Element => {
  return <div data-app-root />;
};
