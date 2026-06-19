/**
 * apps/dashboard/src/app/router.tsx — route table.
 *
 * Feature-Sliced Design: routes are declared in src/app/ because
 * they are app-wide composition. Page components live in
 * src/pages/ (FSD "pages" layer — one per route).
 *
 * Recovery Center is lazy-loaded via React.lazy so its recovery
 * page bundle (DataTable + Dialog + 8 sections + search) does not
 * inflate the initial route bundle. Vite splits this into its own
 * chunk that is fetched only when /recovery-center is visited.
 *
 * Local-only tool — no login page, no auth gate. All routes render
 * inside <AppShell>, which provides the nav + content outlet.
 */
import { Suspense, lazy, type ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "@/widgets/app-shell";
import { OverviewPage } from "@/pages/overview";
import { TimelinePage } from "@/pages/timeline";
import { KnowledgeGraphPage } from "@/pages/knowledge-graph";
import { DecisionGraphPage } from "@/pages/decision-graph";
import { VerificationPage } from "@/pages/verification";
import { SettingsPage } from "@/pages/settings";
import { Skeleton } from "@/shared/ui/skeleton";

const RecoveryCenterPage = lazy(() =>
  import("@/pages/recovery-center").then((m) => ({ default: m.RecoveryCenterPage })),
);

const RulesPage = lazy(() =>
  import("@/pages/rules").then((m) => ({ default: m.RulesPage })),
);

const lazyFallback = (
  <div className="flex flex-col gap-3 p-6" data-testid="route-suspense-fallback">
    <Skeleton className="h-10 w-64" />
    <Skeleton className="h-64" />
  </div>
);

const withSuspense = (node: ReactNode): ReactNode => <Suspense fallback={lazyFallback}>{node}</Suspense>;

export const router = createBrowserRouter(
  [
    {
      element: <AppShell />,
      children: [
        { path: "/", element: <OverviewPage /> },
        { path: "/timeline", element: <TimelinePage /> },
        { path: "/knowledge-graph", element: <KnowledgeGraphPage /> },
        { path: "/decision-graph", element: <DecisionGraphPage /> },
        { path: "/verification", element: <VerificationPage /> },
        { path: "/recovery-center", element: withSuspense(<RecoveryCenterPage />) },
        { path: "/rules", element: withSuspense(<RulesPage />) },
        { path: "/settings", element: <SettingsPage /> },
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ],
  { basename: "/" },
);
